export const usageEn = {
  total: "Total reported usage",
  tab: "Usage", breakdown: "Usage by purpose", purposeLabel: "Purpose", allPurposes: "All purposes",
  calls: "Requests", missing: "Usage unavailable", retries: "Retry requests", failed: "Unsuccessful", pending: "Pending / uncertain",
  nonCached: "Non-cached input", unavailable: "Unavailable", noDetails: "No attributed requests recorded.",
  accountingNote: "Totals include reported usage only. Cached input is part of input; reasoning is part of output. These subsets are not added again. Historical request counts are unavailable.",
  history: "Request history", historyNote: "Up to 100 requests per page, newest first. Missing usage is unavailable, not zero. Pending records after a restart have an uncertain outcome. Shared background work is not assigned to an individual Team.",
  refresh: "Refresh", older: "Older requests", time: "Started", model: "Provider / model", status: "Outcome", attempt: "Request attempt", tokens: "Total tokens", origin: "Source details",
  runWork: "Run-level work", shared: "Shared / unallocated", request: "Logical request", invocation: "Invocation", team: "Team run", task: "Task", attemptId: "Task attempt", thread: "Thread", turn: "Turn",
  purposes: { unclassified: "Unclassified", legacy: "Historical / unclassified", conversation: "Conversation", team_task: "Team execution", team_planning: "Team planning", subagent: "Subagent", automation: "Automation", compaction: "Context compaction", title: "Title generation", memory_extraction: "Memory extraction", memory_consolidation: "Memory consolidation", graph_routing: "Graph routing", graph_execution: "Graph execution" },
  statuses: { pending: "Pending / uncertain", completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", retry: "Retried" },
};

export const usageZh = {
  total: "已报告用量合计",
  tab: "用量", breakdown: "按用途统计", purposeLabel: "调用用途", allPurposes: "全部用途",
  calls: "请求次数", missing: "未报告用量", retries: "重试请求", failed: "未成功", pending: "进行中 / 结果不确定",
  nonCached: "未缓存输入", unavailable: "不可用", noDetails: "暂无带来源的请求记录。",
  accountingNote: "总量仅包含已报告的用量。缓存输入包含在输入中，推理包含在输出中，不重复累加。历史数据的请求次数不可用。",
  history: "请求明细", historyNote: "每页最多 100 次请求，按时间倒序排列。缺失用量记为不可用，不记为零。重启后仍未结束的记录表示结果不确定；共享后台工作不归入某个 Team。",
  refresh: "刷新", older: "更早的请求", time: "开始时间", model: "提供商 / 模型", status: "执行结果", attempt: "请求尝试次数", tokens: "总 Token", origin: "来源详情",
  runWork: "运行级工作", shared: "共享 / 未分配", request: "逻辑请求", invocation: "调用", team: "Team 运行", task: "任务", attemptId: "任务尝试", thread: "会话", turn: "轮次",
  purposes: { unclassified: "未分类", legacy: "历史未分类", conversation: "普通对话", team_task: "Team 执行", team_planning: "Team 规划", subagent: "子代理", automation: "自动化", compaction: "上下文压缩", title: "标题生成", memory_extraction: "记忆提取", memory_consolidation: "记忆整理", graph_routing: "图路由", graph_execution: "图执行" },
  statuses: { pending: "进行中 / 结果不确定", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", retry: "已重试" },
};
