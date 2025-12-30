import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { X, RefreshCw, Download, Trash2, ArrowLeft, File, Layers, Bug, Copy, Check, Square, CheckSquare, ArrowUpDown, Clock, Scissors } from 'lucide-react';

interface LogViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string; // 现在这个字段直接包含原始JSON字符串
  source?: string;
  reqId?: string;
  [key: string]: any; // 允许动态属性，如msg、url、body等
}

interface LogFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

interface GroupedLogs {
  [reqId: string]: LogEntry[];
}

interface LogGroupSummary {
  reqId: string;
  logCount: number;
  firstLog: string;
  lastLog: string;
  model?: string;
  // Enhanced quick glance fields
  totalChars: number;        // Total characters in this group
  method?: string;           // HTTP method (GET/POST)
  url?: string;              // Request URL
  responseStatus?: number;   // HTTP response status
  responseTime?: number;     // Response time in ms
  contentPreview?: string;   // First ~60 chars of user message
}

interface GroupedLogsResponse {
  grouped: boolean;
  groups: { [reqId: string]: LogEntry[] };
  summary: {
    totalRequests: number;
    totalLogs: number;
    requests: LogGroupSummary[];
  };
}

export function LogViewer({ open, onOpenChange, showToast }: LogViewerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [logs, setLogs] = useState<string[]>([]);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<LogFile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [groupByReqId, setGroupByReqId] = useState(true); // Default to grouped view
  const [groupedLogs, setGroupedLogs] = useState<GroupedLogsResponse | null>(null);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [copiedReqId, setCopiedReqId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'duration' | 'status'>('newest');
  const [endpointFilter, setEndpointFilter] = useState<Set<string>>(new Set());
  const [isTruncated, setIsTruncated] = useState(true); // Truncate long content by default
  // GCLI2API Integration state
  const [gcli2apiLogs, setGcli2apiLogs] = useState<any[] | null>(null);
  const [gcli2apiLoading, setGcli2apiLoading] = useState(false);
  const [showGcli2apiModal, setShowGcli2apiModal] = useState(false);
  const [gcli2apiReqId, setGcli2apiReqId] = useState<string | null>(null);
  const [showSideBySide, setShowSideBySide] = useState(false); // Side-by-side comparison
  const [config, setConfig] = useState<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const editorRef = useRef<any>(null);


  // Truncation helper - truncates long strings with preview of start and end
  const truncateText = (text: string, maxLength: number = 500): string => {
    if (!text || text.length <= maxLength) return text;
    const startLen = Math.min(150, Math.floor(maxLength * 0.6)); // 60% at start for context
    const endLen = Math.min(80, Math.floor(maxLength * 0.3));    // 30% at end
    const start = text.substring(0, startLen);
    const end = text.substring(text.length - endLen);
    return `${start} ... [truncated ${text.length - startLen - endLen} chars] ... ${end}`;
  };

  // Fields that should be truncated if long (these contain actual content)
  const TRUNCATABLE_FIELDS = new Set([
    'text', 'content', 'thinking', 'system', 'input', 'output',
    'message', 'prompt', 'response', 'reasoning', 'data'
  ]);

  // Fields that should NEVER be truncated (important metadata)
  const PRESERVE_FIELDS = new Set([
    'model', 'role', 'type', 'name', 'id', 'reqId', 'url', 'method',
    'status', 'statusCode', 'level', 'msg', 'time', 'pid', 'hostname',
    'endpoint', 'provider', 'api_key', 'error', 'code'
  ]);

  // Truncate long values in a JSON object (for log display)
  const truncateLogContent = (logLine: string): string => {
    try {
      const log = JSON.parse(logLine);

      const truncateValue = (value: any, key: string = '', depth: number = 0): any => {
        // Prevent infinite recursion but allow deep nesting for messages
        if (depth > 15) return value;

        // Handle strings
        if (typeof value === 'string') {
          // Never truncate preserved fields
          if (PRESERVE_FIELDS.has(key)) {
            return value;
          }
          // Aggressively truncate known content fields
          if (TRUNCATABLE_FIELDS.has(key) && value.length > 150) {
            return truncateText(value, 150);
          }
          // Truncate any long string (catches nested text)
          if (value.length > 200) {
            return truncateText(value, 200);
          }
          return value;
        }

        // Handle arrays (like messages array)
        if (Array.isArray(value)) {
          return value.map((v, i) => truncateValue(v, key, depth + 1));
        }

        // Handle objects
        if (value && typeof value === 'object') {
          const result: any = {};
          for (const k of Object.keys(value)) {
            result[k] = truncateValue(value[k], k, depth + 1);
          }
          return result;
        }

        return value;
      };

      return JSON.stringify(truncateValue(log));
    } catch {
      // If not valid JSON, truncate as plain text
      return truncateText(logLine, 500);
    }
  };

  useEffect(() => {
    if (open) {
      loadLogFiles();
      // Load config for gcli2api integration
      api.getConfig().then(cfg => setConfig(cfg)).catch(console.error);
    }
  }, [open]);

  // Fetch logs from gcli2api for cross-application log correlation
  const fetchGcli2ApiLogs = async (reqId: string) => {
    if (!config?.gcli2api?.url || !config?.gcli2api?.token) {
      if (showToast) {
        showToast(t('log_viewer.gcli2api_not_configured'), 'warning');
      }
      return;
    }

    try {
      setGcli2apiLoading(true);
      setGcli2apiReqId(reqId);
      const result = await api.queryGcli2ApiLogs(
        config.gcli2api.url,
        config.gcli2api.token,
        reqId
      );
      setGcli2apiLogs(result.logs);
      setShowSideBySide(true); // Enable side-by-side comparison
    } catch (error) {
      if (showToast) {
        showToast(t('log_viewer.gcli2api_fetch_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setGcli2apiLoading(false);
    }
  };


  // 创建内联 Web Worker
  const createInlineWorker = (): Worker => {
    const workerCode = `
      // 日志聚合Web Worker
      self.onmessage = function(event) {
        const { type, data } = event.data;
        
        if (type === 'groupLogsByReqId') {
          try {
            const { logs } = data;
            
            // 按reqId聚合日志
            const groupedLogs = {};
            
            logs.forEach((log, index) => {
              log = JSON.parse(log);
              let reqId = log.reqId || 'no-req-id';
              
              if (!groupedLogs[reqId]) {
                groupedLogs[reqId] = [];
              }
              groupedLogs[reqId].push(log);
            });

            // 按时间戳排序每个组的日志
            Object.keys(groupedLogs).forEach(reqId => {
              groupedLogs[reqId].sort((a, b) => a.time - b.time);
            });

            // 提取model信息
            const extractModelInfo = (reqId) => {
              const logGroup = groupedLogs[reqId];
              for (const log of logGroup) {
                try {
                  // 尝试从message字段解析JSON
                  if (log.type === 'request body' && log.data && log.data.model) {
                    return log.data.model;
                  }
                } catch (e) {
                  // 解析失败，继续尝试下一条日志
                }
              }
              return undefined;
            };

            // 提取快速预览信息 (Quick Glance)
            const extractQuickGlance = (reqId) => {
              const logGroup = groupedLogs[reqId];
              let method = undefined;
              let url = undefined;
              let responseStatus = undefined;
              let responseTime = undefined;
              let contentPreview = undefined;
              let totalChars = 0;

              for (const log of logGroup) {
                // 计算总字符数
                totalChars += JSON.stringify(log).length;

                try {
                  // 提取HTTP方法和URL (from "incoming request")
                  if (log.msg === 'incoming request' && log.req) {
                    method = log.req.method;
                    url = log.req.url;
                  }

                  // 提取响应状态和时间 (from "request completed")
                  if (log.msg === 'request completed') {
                    if (log.res && log.res.statusCode) {
                      responseStatus = log.res.statusCode;
                    }
                    if (log.responseTime) {
                      responseTime = Math.round(log.responseTime);
                    }
                  }

                  // 提取用户消息预览 (from request body)
                  if (!contentPreview && log.type === 'request body' && log.data && log.data.messages) {
                    const messages = log.data.messages;
                    // 找到最后一条user消息
                    for (let i = messages.length - 1; i >= 0; i--) {
                      const msg = messages[i];
                      if (msg.role === 'user' && msg.content) {
                        let text = '';
                        if (typeof msg.content === 'string') {
                          text = msg.content;
                        } else if (Array.isArray(msg.content)) {
                          // 找到第一个text类型的内容
                          const textItem = msg.content.find(c => c.type === 'text' && c.text);
                          if (textItem) {
                            text = textItem.text;
                          }
                        }
                        if (text) {
                          // 截取前60个字符
                          contentPreview = text.length > 60 ? text.substring(0, 60) + '...' : text;
                          break;
                        }
                      }
                    }
                  }
                } catch (e) {
                  // 解析失败，继续
                }
              }

              return { method, url, responseStatus, responseTime, contentPreview, totalChars };
            };

            // 生成摘要信息
            const summary = {
              totalRequests: Object.keys(groupedLogs).length,
              totalLogs: logs.length,
              requests: Object.keys(groupedLogs).map(reqId => {
                const quickGlance = extractQuickGlance(reqId);
                return {
                  reqId,
                  logCount: groupedLogs[reqId].length,
                  firstLog: groupedLogs[reqId][0]?.time,
                  lastLog: groupedLogs[reqId][groupedLogs[reqId].length - 1]?.time,
                  model: extractModelInfo(reqId),
                  ...quickGlance
                };
              })
            };

            const response = {
              grouped: true,
              groups: groupedLogs,
              summary
            };

            // 发送结果回主线程
            self.postMessage({
              type: 'groupLogsResult',
              data: response
            });
          } catch (error) {
            // 发送错误回主线程
            self.postMessage({
              type: 'error',
              error: error instanceof Error ? error.message : 'Unknown error occurred'
            });
          }
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    return new Worker(workerUrl);
  };

  // 初始化Web Worker
  useEffect(() => {
    if (typeof Worker !== 'undefined') {
      try {
        // 创建内联Web Worker
        workerRef.current = createInlineWorker();

        // 监听Worker消息
        workerRef.current.onmessage = (event) => {
          const { type, data, error } = event.data;

          if (type === 'groupLogsResult') {
            setGroupedLogs(data);
          } else if (type === 'error') {
            console.error('Worker error:', error);
            if (showToast) {
              showToast(t('log_viewer.worker_error') + ': ' + error, 'error');
            }
          }
        };

        // 监听Worker错误
        workerRef.current.onerror = (error) => {
          console.error('Worker error:', error);
          if (showToast) {
            showToast(t('log_viewer.worker_init_failed'), 'error');
          }
        };
      } catch (error) {
        console.error('Failed to create worker:', error);
        if (showToast) {
          showToast(t('log_viewer.worker_init_failed'), 'error');
        }
      }
    }

    // 清理Worker
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [showToast, t]);

  useEffect(() => {
    if (autoRefresh && open && selectedFile) {
      refreshInterval.current = setInterval(() => {
        loadLogs();
      }, 5000); // Refresh every 5 seconds
    } else if (refreshInterval.current) {
      clearInterval(refreshInterval.current);
    }

    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }
    };
  }, [autoRefresh, open, selectedFile]);

  // Load logs when selected file changes
  useEffect(() => {
    if (selectedFile && open) {
      setLogs([]); // Clear existing logs
      loadLogs();
    }
  }, [selectedFile, open]);

  // Handle open/close animations
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      // Trigger the animation after a small delay to ensure the element is rendered
      requestAnimationFrame(() => {
        setIsAnimating(true);
      });
    } else {
      setIsAnimating(false);
      // Wait for the animation to complete before hiding
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const loadLogFiles = async () => {
    try {
      setIsLoading(true);
      const response = await api.getLogFiles();

      if (response && Array.isArray(response)) {
        setLogFiles(response);
        setSelectedFile(null);
        setLogs([]);
      } else {
        setLogFiles([]);
        if (showToast) {
          showToast(t('log_viewer.no_log_files_available'), 'warning');
        }
      }
    } catch (error) {
      console.error('Failed to load log files:', error);
      if (showToast) {
        showToast(t('log_viewer.load_files_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadLogs = async () => {
    if (!selectedFile) return;

    try {
      setIsLoading(true);
      setGroupedLogs(null);
      setSelectedReqId(null);

      // 始终加载原始日志数据
      const response = await api.getLogs(selectedFile.path);

      if (response && Array.isArray(response)) {
        // 现在接口返回的是原始日志字符串数组，直接存储
        setLogs(response);

        // 如果启用了分组，使用Web Worker进行聚合（需要转换为LogEntry格式供Worker使用）
        if (groupByReqId && workerRef.current) {
          // const workerLogs: LogEntry[] = response.map((logLine, index) => ({
          //   timestamp: new Date().toISOString(),
          //   level: 'info',
          //   message: logLine,
          //   source: undefined,
          //   reqId: undefined
          // }));

          workerRef.current.postMessage({
            type: 'groupLogsByReqId',
            data: { logs: response }
          });
        } else {
          setGroupedLogs(null);
        }
      } else {
        setLogs([]);
        setGroupedLogs(null);
        if (showToast) {
          showToast(t('log_viewer.no_logs_available'), 'warning');
        }
      }
    } catch (error) {
      console.error('Failed to load logs:', error);
      if (showToast) {
        showToast(t('log_viewer.load_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!selectedFile) return;

    try {
      await api.clearLogs(selectedFile.path);
      setLogs([]);
      if (showToast) {
        showToast(t('log_viewer.logs_cleared'), 'success');
      }
    } catch (error) {
      console.error('Failed to clear logs:', error);
      if (showToast) {
        showToast(t('log_viewer.clear_failed') + ': ' + (error as Error).message, 'error');
      }
    }
  };

  const selectFile = (file: LogFile) => {
    setSelectedFile(file);
    setAutoRefresh(false); // Reset auto refresh when changing files
  };


  const toggleGroupByReqId = () => {
    const newValue = !groupByReqId;
    setGroupByReqId(newValue);

    if (newValue && selectedFile && logs.length > 0) {
      // 启用聚合时，如果已有日志，则使用Worker进行聚合
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'groupLogsByReqId',
          data: { logs }
        });
      }
    } else if (!newValue) {
      // 禁用聚合时，清除聚合结果
      setGroupedLogs(null);
      setSelectedReqId(null);
    }
  };

  const selectReqId = (reqId: string) => {
    setSelectedReqId(reqId);
  };

  // Copy a single group's logs to clipboard
  const copyGroup = async (reqId: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    const logs = groupedLogs?.groups[reqId];
    if (logs) {
      const text = logs.map(l => JSON.stringify(l)).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        setCopiedReqId(reqId);
        setTimeout(() => setCopiedReqId(null), 2000);
        if (showToast) {
          showToast(t('log_viewer.copied'), 'success');
        }
      } catch (err) {
        if (showToast) {
          showToast(t('log_viewer.copy_failed'), 'error');
        }
      }
    }
  };

  // Copy multiple selected groups to clipboard
  const copySelectedGroups = async () => {
    if (selectedGroups.size === 0 || !groupedLogs) return;

    const allLogs: string[] = [];
    selectedGroups.forEach(reqId => {
      const logs = groupedLogs.groups[reqId];
      if (logs) {
        allLogs.push(`=== ${reqId} ===`);
        allLogs.push(...logs.map(l => JSON.stringify(l)));
        allLogs.push(''); // Empty line between groups
      }
    });

    try {
      await navigator.clipboard.writeText(allLogs.join('\n'));
      if (showToast) {
        showToast(t('log_viewer.copied_multiple', { count: selectedGroups.size }), 'success');
      }
      setSelectedGroups(new Set()); // Clear selection after copy
    } catch (err) {
      if (showToast) {
        showToast(t('log_viewer.copy_failed'), 'error');
      }
    }
  };

  // Toggle selection of a group for multi-select
  const toggleGroupSelection = (reqId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(reqId)) {
        newSet.delete(reqId);
      } else {
        newSet.add(reqId);
      }
      return newSet;
    });
  };

  // Select/deselect all groups
  const toggleSelectAllGroups = () => {
    if (!groupedLogs) return;
    const allReqIds = groupedLogs.summary.requests.map(r => r.reqId);
    if (selectedGroups.size === allReqIds.length) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(allReqIds));
    }
  };


  const getDisplayLogs = () => {
    if (groupByReqId && groupedLogs) {
      if (selectedReqId && groupedLogs.groups[selectedReqId]) {
        return groupedLogs.groups[selectedReqId];
      }
      // 当在分组模式但没有选中具体请求时，显示原始日志字符串数组
      return logs.map(logLine => ({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: logLine,
        source: undefined,
        reqId: undefined
      }));
    }
    // 当不在分组模式时，显示原始日志字符串数组
    return logs.map(logLine => ({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: logLine,
      source: undefined,
      reqId: undefined
    }));
  };

  const downloadLogs = () => {
    if (!selectedFile || logs.length === 0) return;

    // 直接下载原始日志字符串，每行一个日志
    const logText = logs.join('\n');

    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedFile.name}-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (showToast) {
      showToast(t('log_viewer.logs_downloaded'), 'success');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // 面包屑导航项类型
  interface BreadcrumbItem {
    id: string;
    label: string;
    onClick: () => void;
  }

  // 获取面包屑导航项
  const getBreadcrumbs = (): BreadcrumbItem[] => {
    const breadcrumbs: BreadcrumbItem[] = [
      {
        id: 'root',
        label: t('log_viewer.title'),
        onClick: () => {
          setSelectedFile(null);
          setAutoRefresh(false);
          setLogs([]);
          setGroupedLogs(null);
          setSelectedReqId(null);
          setGroupByReqId(false);
        }
      }
    ];

    if (selectedFile) {
      breadcrumbs.push({
        id: 'file',
        label: selectedFile.name,
        onClick: () => {
          if (groupByReqId) {
            // 如果在分组模式下，点击文件层级应该返回到分组列表
            setSelectedReqId(null);
          } else {
            // 如果不在分组模式下，点击文件层级关闭分组功能
            setSelectedReqId(null);
            setGroupedLogs(null);
            setGroupByReqId(false);
          }
        }
      });
    }

    if (selectedReqId) {
      breadcrumbs.push({
        id: 'req',
        label: `${t('log_viewer.request')} ${selectedReqId}`,
        onClick: () => {
          // 点击当前层级时不做任何操作
        }
      });
    }

    return breadcrumbs;
  };

  // 获取返回按钮的处理函数
  const getBackAction = (): (() => void) | null => {
    if (selectedReqId) {
      return () => {
        setSelectedReqId(null);
      };
    } else if (selectedFile) {
      return () => {
        setSelectedFile(null);
        setAutoRefresh(false);
        setLogs([]);
        setGroupedLogs(null);
        setSelectedReqId(null);
        setGroupByReqId(false);
      };
    }
    return null;
  };

  const formatLogsForEditor = () => {
    // 如果在分组模式且选中了具体请求，显示该请求的日志
    if (groupByReqId && groupedLogs && selectedReqId && groupedLogs.groups[selectedReqId]) {
      const requestLogs = groupedLogs.groups[selectedReqId];
      // 提取原始JSON字符串并每行一个
      if (isTruncated) {
        return requestLogs.map(log => truncateLogContent(JSON.stringify(log))).join('\n');
      }
      return requestLogs.map(log => JSON.stringify(log)).join('\n');
    }

    // 其他情况，直接显示原始日志字符串数组，每行一个
    if (isTruncated) {
      return logs.map(log => truncateLogContent(log)).join('\n');
    }
    return logs.join('\n');
  };

  // 解析日志行，获取final request的行号
  const getFinalRequestLines = () => {
    const lines: number[] = [];

    if (groupByReqId && groupedLogs && selectedReqId && groupedLogs.groups[selectedReqId]) {
      // 分组模式下，检查选中的请求日志
      const requestLogs = groupedLogs.groups[selectedReqId];
      requestLogs.forEach((log, index) => {
        try {
          // @ts-ignore
          log = JSON.parse(log)
          // 检查日志的msg字段是否等于"final request"
          if (log.msg === "final request") {
            lines.push(index + 1); // 行号从1开始
          }
        } catch (e) {
          // 解析失败，跳过
        }
      });
    } else {
      // 非分组模式下，检查原始日志
      logs.forEach((logLine, index) => {
        try {
          const log = JSON.parse(logLine);
          // 检查日志的msg字段是否等于"final request"
          if (log.msg === "final request") {
            lines.push(index + 1); // 行号从1开始
          }
        } catch (e) {
          // 解析失败，跳过
        }
      });
    }

    return lines;
  };

  // 处理调试按钮点击
  const handleDebugClick = (lineNumber: number) => {
    console.log('handleDebugClick called with lineNumber:', lineNumber);
    console.log('Current state:', { groupByReqId, selectedReqId, logsLength: logs.length });

    let logData = null;

    if (groupByReqId && groupedLogs && selectedReqId && groupedLogs.groups[selectedReqId]) {
      // 分组模式下获取日志数据
      const requestLogs = groupedLogs.groups[selectedReqId];
      console.log('Group mode - requestLogs length:', requestLogs.length);
      logData = requestLogs[lineNumber - 1]; // 行号转换为数组索引
      console.log('Group mode - logData:', logData);
    } else {
      // 非分组模式下获取日志数据
      console.log('Non-group mode - logs length:', logs.length);
      try {
        const logLine = logs[lineNumber - 1];
        console.log('Log line:', logLine);
        logData = JSON.parse(logLine);
        console.log('Parsed logData:', logData);
      } catch (e) {
        console.error('Failed to parse log data:', e);
      }
    }

    if (logData) {
      console.log('Navigating to debug page with logData:', logData);
      // 导航到调试页面，并传递日志数据作为URL参数
      const logDataParam = encodeURIComponent(JSON.stringify(logData));
      console.log('Encoded logDataParam length:', logDataParam.length);
      navigate(`/debug?logData=${logDataParam}`);
    } else {
      console.error('No log data found for line:', lineNumber);
    }
  };

  // 配置Monaco Editor
  const configureEditor = (editor: any) => {
    editorRef.current = editor;

    // 启用glyph margin
    editor.updateOptions({
      glyphMargin: true,
    });

    // 存储当前的装饰ID
    let currentDecorations: string[] = [];

    // 添加glyph margin装饰
    const updateDecorations = () => {
      const finalRequestLines = getFinalRequestLines();
      const decorations = finalRequestLines.map(lineNumber => ({
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: 1
        },
        options: {
          glyphMarginClassName: 'debug-button-glyph',
          glyphMarginHoverMessage: { value: '点击调试此请求' }
        }
      }));

      // 使用deltaDecorations正确更新装饰，清理旧的装饰
      currentDecorations = editor.deltaDecorations(currentDecorations, decorations);
    };

    // 初始更新装饰
    updateDecorations();

    // 监听glyph margin点击 - 使用正确的事件监听方式
    editor.onMouseDown((e: any) => {
      console.log('Mouse down event:', e.target);
      console.log('Event details:', {
        type: e.target.type,
        hasDetail: !!e.target.detail,
        glyphMarginLane: e.target.detail?.glyphMarginLane,
        offsetX: e.target.detail?.offsetX,
        glyphMarginLeft: e.target.detail?.glyphMarginLeft,
        glyphMarginWidth: e.target.detail?.glyphMarginWidth
      });

      // 检查是否点击在glyph margin区域
      const isGlyphMarginClick = e.target.detail &&
        e.target.detail.glyphMarginLane !== undefined &&
        e.target.detail.offsetX !== undefined &&
        e.target.detail.offsetX <= e.target.detail.glyphMarginLeft + e.target.detail.glyphMarginWidth;

      console.log('Is glyph margin click:', isGlyphMarginClick);

      if (e.target.position && isGlyphMarginClick) {
        const finalRequestLines = getFinalRequestLines();
        console.log('Final request lines:', finalRequestLines);
        console.log('Clicked line number:', e.target.position.lineNumber);
        if (finalRequestLines.includes(e.target.position.lineNumber)) {
          console.log('Opening debug page for line:', e.target.position.lineNumber);
          handleDebugClick(e.target.position.lineNumber);
        }
      }
    });

    // 尝试使用 onGlyphMarginClick 如果可用
    if (typeof editor.onGlyphMarginClick === 'function') {
      editor.onGlyphMarginClick((e: any) => {
        console.log('Glyph margin click event:', e);
        const finalRequestLines = getFinalRequestLines();
        if (finalRequestLines.includes(e.target.position.lineNumber)) {
          console.log('Opening debug page for line (glyph):', e.target.position.lineNumber);
          handleDebugClick(e.target.position.lineNumber);
        }
      });
    }

    // 添加鼠标移动事件来检测悬停在调试按钮上
    editor.onMouseMove((e: any) => {
      if (e.target.position && (e.target.type === 4 || e.target.type === 'glyph-margin')) {
        const finalRequestLines = getFinalRequestLines();
        if (finalRequestLines.includes(e.target.position.lineNumber)) {
          // 可以在这里添加悬停效果
          editor.updateOptions({
            glyphMargin: true,
          });
        }
      }
    });

    // 当日志变化时更新装饰
    const interval = setInterval(updateDecorations, 1000);

    return () => {
      clearInterval(interval);
      // 清理装饰
      if (editorRef.current) {
        editorRef.current.deltaDecorations(currentDecorations, []);
      }
    };
  };

  if (!isVisible && !open) {
    return null;
  }

  return (
    <>
      {(isVisible || open) && (
        <div
          className={`fixed inset-0 z-50 transition-all duration-300 ease-out ${isAnimating && open ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
            }`}
          onClick={() => onOpenChange(false)}
        />
      )}

      <div
        ref={containerRef}
        className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-white shadow-2xl transition-all duration-300 ease-out transform ${isAnimating && open ? 'translate-y-0' : 'translate-y-full'
          }`}
        style={{
          height: '100vh',
          maxHeight: '100vh'
        }}
      >
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-2">
            {getBackAction() && (
              <Button
                variant="ghost"
                size="sm"
                onClick={getBackAction()!}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('log_viewer.back')}
              </Button>
            )}

            {/* 面包屑导航 */}
            <nav className="flex items-center space-x-1 text-sm">
              {getBreadcrumbs().map((breadcrumb, index) => (
                <React.Fragment key={breadcrumb.id}>
                  {index > 0 && (
                    <span className="text-gray-400 mx-1">/</span>
                  )}
                  {index === getBreadcrumbs().length - 1 ? (
                    <span className="text-gray-900 font-medium">
                      {breadcrumb.label}
                    </span>
                  ) : (
                    <button
                      onClick={breadcrumb.onClick}
                      className="text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      {breadcrumb.label}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </nav>
          </div>
          <div className="flex gap-2">
            {selectedFile && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleGroupByReqId}
                  className={groupByReqId ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <Layers className="h-4 w-4 mr-2" />
                  {groupByReqId ? t('log_viewer.grouped_on') : t('log_viewer.group_by_req_id')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className={autoRefresh ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`} />
                  {autoRefresh ? t('log_viewer.auto_refresh_on') : t('log_viewer.auto_refresh_off')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsTruncated(!isTruncated)}
                  className={isTruncated ? 'bg-orange-100 text-orange-700' : ''}
                  title={isTruncated ? t('log_viewer.truncate_on') : t('log_viewer.truncate_off')}
                >
                  <Scissors className="h-4 w-4 mr-2" />
                  {isTruncated ? t('log_viewer.truncate_on') : t('log_viewer.truncate_off')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadLogs}
                  disabled={logs.length === 0}
                >
                  <Download className="h-4 w-4 mr-2" />
                  {t('log_viewer.download')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearLogs}
                  disabled={logs.length === 0}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('log_viewer.clear')}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4 mr-2" />
              {t('log_viewer.close')}
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 bg-gray-50">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : selectedFile ? (
            <>
              {groupByReqId && groupedLogs && !selectedReqId ? (
                // 显示日志组列表
                <div className="flex flex-col h-full p-6">
                  <div className="mb-4 flex-shrink-0 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-medium mb-2">{t('log_viewer.request_groups')}</h3>
                      <p className="text-sm text-gray-600">
                        {t('log_viewer.total_requests')}: {groupedLogs.summary.totalRequests} |
                        {t('log_viewer.total_logs')}: {groupedLogs.summary.totalLogs}
                      </p>
                    </div>
                    {/* Sort, Filter, and Multi-select actions */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Sort dropdown */}
                      <select
                        value={sortOrder}
                        onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest' | 'duration' | 'status')}
                        className="text-xs border rounded px-2 py-1 bg-white"
                      >
                        <option value="newest">{t('log_viewer.sort_newest')}</option>
                        <option value="oldest">{t('log_viewer.sort_oldest')}</option>
                        <option value="duration">{t('log_viewer.sort_duration')}</option>
                        <option value="status">{t('log_viewer.sort_status')}</option>
                      </select>

                      {/* Endpoint filter dropdown */}
                      <div className="relative group">
                        <button className="text-xs border rounded px-2 py-1 bg-white flex items-center gap-1 hover:bg-gray-50">
                          {t('log_viewer.filter_endpoint')}
                          {endpointFilter.size > 0 && (
                            <span className="bg-blue-500 text-white rounded-full px-1.5 text-[10px]">
                              {endpointFilter.size}
                            </span>
                          )}
                        </button>
                        <div className="absolute top-full left-0 mt-1 bg-white border rounded shadow-lg z-10 hidden group-hover:block min-w-[200px] max-h-[300px] overflow-y-auto">
                          <div className="p-2 border-b">
                            <button
                              onClick={() => setEndpointFilter(new Set())}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              {t('log_viewer.clear_filter')}
                            </button>
                          </div>
                          {(() => {
                            // Get unique endpoints from requests
                            const uniqueEndpoints = [...new Set(
                              groupedLogs.summary.requests
                                .map(r => r.url || 'unknown')
                                .filter(Boolean)
                            )].sort();
                            return uniqueEndpoints.map(endpoint => (
                              <label
                                key={endpoint}
                                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 cursor-pointer text-xs"
                              >
                                <input
                                  type="checkbox"
                                  checked={endpointFilter.has(endpoint)}
                                  onChange={(e) => {
                                    const newFilter = new Set(endpointFilter);
                                    if (e.target.checked) {
                                      newFilter.add(endpoint);
                                    } else {
                                      newFilter.delete(endpoint);
                                    }
                                    setEndpointFilter(newFilter);
                                  }}
                                  className="rounded"
                                />
                                <span className="truncate" title={endpoint}>{endpoint}</span>
                              </label>
                            ));
                          })()}
                        </div>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleSelectAllGroups}
                        className="text-xs"
                      >
                        {selectedGroups.size === groupedLogs.summary.requests.length ? (
                          <><CheckSquare className="h-4 w-4 mr-1" />{t('log_viewer.deselect_all')}</>
                        ) : (
                          <><Square className="h-4 w-4 mr-1" />{t('log_viewer.select_all')}</>
                        )}
                      </Button>
                      {selectedGroups.size > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={copySelectedGroups}
                          className="text-xs"
                        >
                          <Copy className="h-4 w-4 mr-1" />
                          {t('log_viewer.copy_selected')} ({selectedGroups.size})
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
                    {[...groupedLogs.summary.requests]
                      .filter(request => {
                        // If no filter selected, show all
                        if (endpointFilter.size === 0) return true;
                        // Otherwise, show only requests matching selected endpoints
                        return endpointFilter.has(request.url || 'unknown');
                      })
                      .sort((a, b) => {
                        switch (sortOrder) {
                          case 'newest':
                            return Number(b.lastLog || 0) - Number(a.lastLog || 0);
                          case 'oldest':
                            return Number(a.firstLog || 0) - Number(b.firstLog || 0);
                          case 'duration':
                            return (b.responseTime || 0) - (a.responseTime || 0);
                          case 'status':
                            // Sort errors (4xx, 5xx) first, then by status code descending
                            const aError = a.responseStatus && a.responseStatus >= 400 ? 1 : 0;
                            const bError = b.responseStatus && b.responseStatus >= 400 ? 1 : 0;
                            if (bError !== aError) return bError - aError;
                            return (b.responseStatus || 0) - (a.responseStatus || 0);
                          default:
                            return 0;
                        }
                      }).map((request) => (
                        <div
                          key={request.reqId}
                          className={`border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors ${selectedGroups.has(request.reqId) ? 'bg-blue-50 border-blue-300' : ''
                            }`}
                          onClick={() => selectReqId(request.reqId)}
                        >
                          {/* Header row: checkbox, reqId, model badge */}
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              {/* Multi-select checkbox */}
                              <button
                                onClick={(e) => toggleGroupSelection(request.reqId, e)}
                                className="p-1 hover:bg-gray-200 rounded transition-colors"
                              >
                                {selectedGroups.has(request.reqId) ? (
                                  <CheckSquare className="h-4 w-4 text-blue-600" />
                                ) : (
                                  <Square className="h-4 w-4 text-gray-400" />
                                )}
                              </button>
                              <File className="h-5 w-5 text-blue-600" />
                              <span className="font-medium text-sm">{request.reqId}</span>
                              {request.model && (
                                <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                                  {request.model}
                                </span>
                              )}
                            </div>
                            {/* Action buttons */}
                            <div className="flex items-center gap-1">
                              {/* GCLI2API Logs button - always show if gcli2api configured */}
                              {config?.gcli2api && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    fetchGcli2ApiLogs(request.reqId);
                                  }}
                                  className="p-2 hover:bg-gray-200 rounded transition-colors"
                                  title={t('log_viewer.view_gcli2api_logs')}
                                  disabled={gcli2apiLoading}
                                >
                                  <Layers className={`h-4 w-4 ${gcli2apiLoading && gcli2apiReqId === request.reqId ? 'animate-pulse text-blue-500' : 'text-purple-500'}`} />
                                </button>
                              )}

                              {/* Copy button */}
                              <button
                                onClick={(e) => copyGroup(request.reqId, e)}
                                className="p-2 hover:bg-gray-200 rounded transition-colors"
                                title={t('log_viewer.copy')}
                              >
                                {copiedReqId === request.reqId ? (
                                  <Check className="h-4 w-4 text-green-600" />
                                ) : (
                                  <Copy className="h-4 w-4 text-gray-500" />
                                )}
                              </button>
                            </div>
                          </div>


                          {/* Quick glance: method, URL, status, time */}
                          {(request.method || request.url) && (
                            <div className="text-sm text-gray-700 mb-2 flex items-center gap-2 flex-wrap">
                              {request.method && (
                                <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">
                                  {request.method}
                                </span>
                              )}
                              {request.url && (
                                <span className="text-gray-600 truncate max-w-xs" title={request.url}>
                                  {request.url}
                                </span>
                              )}
                              {request.responseStatus && (
                                <span className={`text-xs px-1.5 py-0.5 rounded ${request.responseStatus >= 200 && request.responseStatus < 300
                                  ? 'bg-green-100 text-green-800'
                                  : request.responseStatus >= 400
                                    ? 'bg-red-100 text-red-800'
                                    : 'bg-yellow-100 text-yellow-800'
                                  }`}>
                                  {request.responseStatus}
                                </span>
                              )}
                              {request.responseTime && (
                                <span className="text-xs text-gray-500">
                                  {request.responseTime}ms
                                </span>
                              )}
                            </div>
                          )}

                          {/* Content preview */}
                          {request.contentPreview && (
                            <div className="text-sm text-gray-600 mb-2 bg-gray-100 px-3 py-2 rounded border-l-4 border-blue-400">
                              <span className="text-gray-400 mr-1">💬</span>
                              "{request.contentPreview}"
                            </div>
                          )}

                          {/* Stats row: log count, size */}
                          <div className="flex items-center justify-between text-xs text-gray-500">
                            <div className="flex items-center gap-3">
                              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded">
                                {request.logCount} {t('log_viewer.logs')}
                              </span>
                              <span>
                                {formatFileSize(request.totalChars || 0)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span>{t('log_viewer.first_log')}: {formatDate(request.firstLog)}</span>
                              <span>→</span>
                              <span>{t('log_viewer.last_log')}: {formatDate(request.lastLog)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ) : (
                // 显示日志内容
                <div className="relative h-full">
                  <Editor
                    height="100%"
                    defaultLanguage="json"
                    value={formatLogsForEditor()}
                    theme="vs"
                    options={{
                      minimap: { enabled: true },
                      fontSize: 14,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      wordWrap: 'on',
                      readOnly: true,
                      lineNumbers: 'on',
                      folding: true,
                      renderWhitespace: 'all',
                      glyphMargin: true,
                    }}
                    onMount={configureEditor}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="p-6">
              <h3 className="text-lg font-medium mb-4">{t('log_viewer.select_file')}</h3>
              {logFiles.length === 0 ? (
                <div className="text-gray-500 text-center py-8">
                  <File className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>{t('log_viewer.no_log_files_available')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {logFiles.map((file) => (
                    <div
                      key={file.path}
                      className="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => selectFile(file)}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <File className="h-5 w-5 text-blue-600" />
                          <span className="font-medium text-sm">{file.name}</span>
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 space-y-1">
                        <div>{formatFileSize(file.size)}</div>
                        <div>{formatDate(file.lastModified)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Side-by-side Log Comparison Modal */}
      {showSideBySide && gcli2apiReqId && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/50"
            onClick={() => { setShowSideBySide(false); setGcli2apiLogs(null); }}
          />
          <div className="fixed inset-4 z-[60] bg-white rounded-lg shadow-xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b p-4">
              <div className="flex items-center gap-3">
                <Layers className="h-5 w-5 text-purple-500" />
                <h3 className="font-semibold">{t('log_viewer.side_by_side_title') || 'Log Comparison'}</h3>
                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded font-mono">{gcli2apiReqId}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setShowSideBySide(false); setGcli2apiLogs(null); }}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Side-by-side panels */}
            <div className="flex-1 min-h-0 flex gap-2 p-4">
              {/* CCR Logs Panel (Left) */}
              <div className="flex-1 flex flex-col border rounded-lg overflow-hidden">
                <div className="flex items-center justify-between bg-blue-50 border-b px-3 py-2">
                  <span className="font-medium text-blue-800 text-sm">CCR Logs</span>
                  <button
                    onClick={() => {
                      const ccrLogs = groupedLogs?.groups[gcli2apiReqId]?.map(l =>
                        typeof l === 'string' ? l : JSON.stringify(l)
                      ).join('\n') || '';
                      navigator.clipboard.writeText(ccrLogs);
                      if (showToast) showToast(t('log_viewer.copied'), 'success');
                    }}
                    className="p-1.5 hover:bg-blue-100 rounded transition-colors"
                    title={t('log_viewer.copy')}
                  >
                    <Copy className="h-4 w-4 text-blue-600" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <Editor
                    height="100%"
                    language="json"
                    theme="vs-dark"
                    value={groupedLogs?.groups[gcli2apiReqId]?.map(l =>
                      typeof l === 'string' ? l : JSON.stringify(l)
                    ).join('\n') || 'No CCR logs found'}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      fontSize: 11,
                    }}
                  />
                </div>
                <div className="bg-blue-50 border-t px-3 py-1.5 text-xs text-blue-600">
                  {groupedLogs?.groups[gcli2apiReqId]?.length || 0} entries
                </div>
              </div>

              {/* GCLI2API Logs Panel (Right) */}
              <div className="flex-1 flex flex-col border rounded-lg overflow-hidden">
                <div className="flex items-center justify-between bg-purple-50 border-b px-3 py-2">
                  <span className="font-medium text-purple-800 text-sm">GCLI2API Logs</span>
                  <button
                    onClick={() => {
                      const gcliLogs = gcli2apiLogs?.map(l => JSON.stringify(l)).join('\n') || '';
                      navigator.clipboard.writeText(gcliLogs);
                      if (showToast) showToast(t('log_viewer.copied'), 'success');
                    }}
                    className="p-1.5 hover:bg-purple-100 rounded transition-colors"
                    title={t('log_viewer.copy')}
                  >
                    <Copy className="h-4 w-4 text-purple-600" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  {gcli2apiLogs && gcli2apiLogs.length > 0 ? (
                    <Editor
                      height="100%"
                      language="json"
                      theme="vs-dark"
                      value={gcli2apiLogs.map(log => JSON.stringify(log)).join('\n')}
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        fontSize: 11,
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 bg-gray-900">
                      {t('log_viewer.no_gcli2api_logs')}
                    </div>
                  )}
                </div>
                <div className="bg-purple-50 border-t px-3 py-1.5 text-xs text-purple-600">
                  {gcli2apiLogs?.length || 0} entries
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Legacy GCLI2API Modal (kept for backward compatibility) */}
      {showGcli2apiModal && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/50"
            onClick={() => setShowGcli2apiModal(false)}
          />
          <div className="fixed inset-x-4 top-[10%] bottom-[10%] z-[60] md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[80%] md:max-w-4xl bg-white rounded-lg shadow-xl flex flex-col">
            <div className="flex items-center justify-between border-b p-4">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-purple-500" />
                <h3 className="font-semibold">{t('log_viewer.gcli2api_logs_title')}</h3>
                {gcli2apiReqId && (
                  <span className="text-xs bg-gray-200 px-2 py-1 rounded font-mono">{gcli2apiReqId}</span>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowGcli2apiModal(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 min-h-0 p-4">
              {gcli2apiLogs && gcli2apiLogs.length > 0 ? (
                <Editor
                  height="100%"
                  language="json"
                  theme="vs-dark"
                  value={gcli2apiLogs.map(log => JSON.stringify(log)).join('\n')}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                  }}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500">
                  {t('log_viewer.no_gcli2api_logs')}
                </div>
              )}
            </div>
            <div className="border-t p-3 text-xs text-gray-500 text-center">
              {gcli2apiLogs ? `${gcli2apiLogs.length} log entries` : ''}
            </div>
          </div>
        </>
      )}
    </>
  );
}

