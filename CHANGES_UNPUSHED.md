# DeepSeek++ 未推送更改系统性整理

> 更新时间：2025-06-15
> 代码变更统计：+3898行/-249行，涉及30个文件

---

## 📊 变更概览

本次更新是一次**重大架构升级**，主要围绕以下核心目标：

1. **子Agent系统** - 实现完整的子Agent执行框架
2. **并行工具执行** - 支持多子Agent并发调度
3. **图片处理增强** - 完整的图片上传和Vision模式支持
4. **调试能力提升** - 全链路trace和日志系统
5. **PDF插图提取** - 新增学术PDF图表提取技能

---

## 🏗️ 核心架构变更

### 1. 子Agent系统 (`core/tool/subagent.ts` - 2065行)

**新增完整的子Agent执行框架，支持：**

- **独立会话管理**：每个子Agent拥有独立的chatSessionId和状态管理
- **超时控制**：会话级5分钟超时，单步2分钟超时
- **重试机制**：最多2次自动重试
- **进度跟踪**：实时SubAgentProgressEvent事件流
- **结果缓存**：确定性artifact路径用于结果存储
- **工具隔离**：独立于主Agent的工具集和执行上下文

**核心接口：**
```typescript
export interface SubAgentProgressEvent {
  runId?: string;
  chatSessionId: string;
  resultFilePath?: string;
  subAgentIndex?: number;
  step: number;
  stepsSoFar: number;
  status: 'starting' | 'thinking' | 'calling_tool' | 'step_done' | 'complete';
  summary: string;
  taskPreview: string;
}
```

### 2. Inline Agent并行执行引擎 (`core/inline-agent/loop.ts`)

**重构核心循环，支持批量并行执行：**

- **批处理调度**：多spawn_subagent调用合并为单次后台请求
- **智能路由**：自动区分子Agent和其他工具的执行策略
- **状态跟踪**：subagentResultFiles自动追踪和清理
- **Vision模式**：自动处理pending image file_ids

**关键变更：**
```typescript
// 批量执行函数
const executeToolsSplit = async (
  calls: readonly ToolCall[],
  signal: AbortSignal,
): Promise<ToolExecutionRecord[]> => {
  if (
    executeToolBatch &&
    calls.length >= 2 &&
    calls.every((c) => c.name === 'spawn_subagent')
  ) {
    return executeToolBatch([...calls]); // 批量调度
  }
  return executeToolCallsInParallel(calls, executeTool, { signal });
};
```

### 3. 工具系统增强

#### 3.1 工具描述符扩展 (`core/tool/subagent-descriptors.ts`)
- 新增`spawn_subagent`工具描述符
- 统一的工具名称空间管理

#### 3.2 分块读取 (`core/tool/chunked-read.ts`)
- 支持大文件的分块读取
- 智能块大小自适应

#### 3.3 委托路由 (`core/tool/delegated-tool-routing.ts`)
- 智能的工具调用路由逻辑
- 支持自动工具选择（当前已禁用）

#### 3.4 Pending Image管理 (`core/tool/pending-image-ids.ts`)
- 跨步的图片file_id状态管理
- Vision模式状态追踪

#### 3.5 任务状态 (`core/tool/task-state.ts`)
- 跨请求的任务状态持久化

---

## 🔧 核心模块增强

### 4. DeepSeek适配器 (`core/deepseek/adapter.ts`)

**新增特性：**

- **refFileIds支持**：支持图片文件引用
- **thinkingText提取**：提取DeepSeek推理内容
- **abortSignal传递**：完整的请求取消支持
- **targetPath动态化**：支持不同API端点

**关键变更：**
```typescript
export interface ModelTurn {
  assistantText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
  thinkingText?: string; // 新增
}

interface StreamReadOptions {
  refFileIds?: string[]; // 新增
}
```

### 5. 图片上传模块 (`core/deepseek/image-upload.ts` - 315行)

**全新模块，提供：**

- **图片上传**：`uploadImageToDeepSeek()`
- **文件上传**：`uploadFileToDeepSeek()`
- **自动重试**：失败自动重试机制
- **进度跟踪**：上传进度事件
- **格式转换**：自动处理图片格式

### 6. 拦截器增强

#### 6.1 工具解析器 (`core/interceptor/tool-parser.ts`)
- **Markdown代码块屏蔽**：避免误解析markdown中的工具调用
- **宽松JSON解析**：自动修复AI生成的JSON错误
- **自动恢复**：智能提取工具调用参数
- **错误提示优化**：更友好的错误信息

**关键新增：**
```typescript
function maskMarkdownCode(text: string): string {
  // 屏蔽markdown代码块和行内代码
  // 避免误解析
}

export function parseJsonLenient(body: string): unknown {
  // 宽松JSON解析，处理常见AI错误
}
```

#### 6.2 SSE解析器 (`core/interceptor/sse-parser.ts`)
- 增强的SSE流解析
- 更好的错误处理

#### 6.3 请求增强器 (`core/interceptor/request-augmentation.ts`)
- **模型类型解析**：`resolveRequestModelType()`
- **同步currentModelType**：确保与UI状态一致

### 7. 工具运行时 (`core/tool/runtime.ts`)

**新增功能：**

- **trace集成**：全链路工具调用追踪
- **文件日志**：工具调用自动记录到/tmp
- **SubAgent集成**：子Agent工具执行支持

### 8. 工具循环引擎 (`core/tool-loop/engine.ts`)

**重构执行策略：**

- **并行执行**：`executeToolCallsInParallel()`
- **继续循环**：`runToolContinuationLoop()`
- **文本裁剪**：`clampText()`

---

## 🛠️ 工具和实用函数

### 9. Shell安全写入 (`core/utils/safe-shell-write.ts`)

**提供安全的shell写入命令生成：**

```typescript
export function buildShellWriteCommand(
  filePath: string,
  content: string,
): string;
```

### 10. Shell引用 (`core/utils/shell-quote.ts`)

**跨平台的shell参数引用：**

```typescript
export function quoteShellArg(arg: string): string;
```

### 11. JSON摘要 (`core/utils/json-summarize.ts`)

**大JSON对象的摘要生成：**

```typescript
export function summarizeForLog(obj: unknown): string;
```

### 12. 引用文件ID (`core/utils/ref-file-id.ts`)

**refFileId相关工具：**

```typescript
export function isInvalidRefFileIdText(text: string): boolean;
```

### 13. 调试日志 (`core/utils/debug-log.ts`)

**结构化调试日志：**

```typescript
export function debugTrace(category: string, message: string, data?: object): void;
export function debugLog(category: string, message: string, data?: object): void;
```

### 14. 工具追踪 (`core/utils/tool-trace.ts`)

**全链路工具调用追踪：**

```typescript
export interface TraceContext {
  source: 'main' | 'sub' | 'manual';
  stepIndex: number;
  subIndex?: number;
}

export function traceToolDispatch(ctx: TraceContext, call: {...}): number;
export function traceToolResult(traceId: number, ctx: TraceContext, callName: string, result: {...}): void;
```

**输出格式：**
```
[DPP][trace][main:3] ▶ shell_exec (cmd: "ls -la ~/Downloads")
[DPP][trace][main:3] ✓ shell_exec 245ms ok (1.2KB)
[DPP][trace][sub:2:5] ▶ shell_read_image (path: "/tmp/img.png")
[DPP][trace][sub:2:5] ✓ shell_read_image 320ms ok → uploaded file_id=abc123
```

### 15. 会话日志 (`core/utils/conversation-logger.ts`)

**Agent会话日志记录：**

```typescript
// 主Agent对话日志
export interface MainAgentConversationLog {
  logType: 'main_agent_conversation';
  timestamp: string;
  loopId: string;
  stepIndex: number;
  chatSessionId: string;
  userPrompt: string;
  systemPrompt: string;
  modelType: string | null;
  refFileIds: string[];
}

// 思考内容日志
export interface ThinkingContentLog {
  logType: 'thinking_content';
  timestamp: string;
  sessionId: string;
  agentType: 'main' | 'sub';
  stepIndex?: number;
  content: string;
}

// 主Agent响应日志
export interface MainAgentResponseLog {
  logType: 'main_agent_response';
  timestamp: string;
  loopId: string;
  stepIndex: number;
  chatSessionId: string;
  assistantText: string;
  thinkingText: string;
}
```

### 16. 工具调用日志 (`core/utils/tool-call-log.ts`)

**工具调用结构化日志：**

```typescript
export function buildToolCallLogEntry(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): ToolCallLogEntry;
```

---

## 🎯 新增技能

### 17. PDF插图提取器 (`core/skill/pdf-illustration-extractor.ts` - 387行)

**全新的学术PDF图表提取技能：**

- **智能检测**：识别PDF中的图表、插图
- **批量提取**：一次性提取所有图表
- **格式转换**：自动转换为可用格式
- **进度跟踪**：实时提取进度

---

## 📱 Content Script重构 (`entrypoints/content.ts` - 5289行)

**大规模重构，新增功能：**

### 并行工具执行
```typescript
// spawn_subagent批量处理
if (call.name === 'spawn_subagent') {
  const pendingIndex = toolExecutions.length;
  const subAgentIndex = pendingSpawnSubAgentCalls.length + 1;
  toolExecutions.push(createQueuedSubAgentExecution(call, subAgentIndex));
  pendingSpawnSubAgentCalls.push({ call, pendingIndex });
  renderToolBlock();
} else {
  void runToolExecution(call);
}
```

### 主Agent响应日志
```typescript
// 记录主Agent的最终响应到文件日志
if (complete.text) {
  void writeMainAgentResponseLog(complete);
}
```

### 自动恢复运行中的Agent
```typescript
// 页面刷新后自动恢复运行中的inline agent
void checkAndResumeRunningAgent();
```

### 模型类型同步
```typescript
// 同步currentModelType与实际请求体
const resolved = hasRequestModelType
  ? resolveRequestModelType(preBody.model_type)
  : configuredModelType;
```

---

## 🧪 测试增强

### 新增测试文件

1. **delegated-tool-routing.test.ts** - 委托路由测试
2. **image-upload.test.ts** - 图片上传测试
3. **inline-agent-loop.test.ts** - Inline Agent循环测试
4. **inline-agent-subagent-progress.test.ts** - 子Agent进度测试
5. **main-agent-response-logging.test.ts** - 主Agent响应日志测试
6. **shell-quote.test.ts** - Shell引用测试
7. **subagent.test.ts** - 子Agent测试
8. **tool-call-log.test.ts** - 工具调用日志测试
9. **tool-parser.test.ts** - 工具解析器测试
10. **tool-loop-engine.test.ts** - 工具循环引擎测试

### 测试增强

- **conversation-export.test.ts** - 会话导出测试增强
- **request-augmentation.test.ts** - 请求增强测试增强

---

## 📦 依赖更新

### package.json变更
```json
{
  // 新增/更新依赖（具体变更需查看package.json）
}
```

---

## 🔍 Shell Host增强

### packages/shell-host/native/shell-mcp-host.mjs
**大规模增强（+811行）：**

- 更好的错误处理
- 增强的进程管理
- 改进的信号处理

---

## 📝 配置变更

### wxt.config.ts
**WXT配置更新（+53行）：**

- 构建优化
- 新增构建选项

---

## 🎨 Prompt增强

### 提示词增强 (`core/prompt/`)

1. **augmentation.ts** - 提示词增强逻辑
2. **visibility.ts** - 可见性控制

---

## 📋 文件清单

### 新增文件（17个）
```
core/deepseek/image-upload.ts
core/inline-agent/subagent-progress.ts
core/skill/pdf-illustration-extractor.ts
core/tool/chunked-read.ts
core/tool/delegated-tool-routing.ts
core/tool/pending-image-ids.ts
core/tool/subagent-descriptors.ts
core/tool/subagent.ts
core/tool/task-state.ts
core/utils/safe-shell-write.ts
core/utils/json-summarize.ts
core/utils/shell-quote.ts
core/utils/ref-file-id.ts
core/utils/conversation-logger.ts
core/utils/tool-trace.ts
core/utils/debug-log.ts
core/utils/tool-call-log.ts
```

### 修改文件（30个）
```
core/deepseek/adapter.ts
core/export/sanitize.ts
core/inline-agent/loop.ts
core/inline-agent/prompt.ts
core/inline-agent/types.ts
core/interceptor/fetch-hook.ts
core/interceptor/request-augmentation.ts
core/interceptor/sse-parser.ts
core/interceptor/tool-parser.ts
core/prompt/augmentation.ts
core/prompt/visibility.ts
core/shell/contracts.ts
core/shell/policy.ts
core/skill/builtin.ts
core/skill/officecli-library.ts
core/tool-loop/engine.ts
core/tool/index.ts
core/tool/invocation.ts
core/tool/runtime.ts
core/tool/web-search.ts
core/types.ts
entrypoints/background.ts
entrypoints/content.ts
package.json
packages/shell-host/native/shell-mcp-host.mjs
scripts/shell-smoke.mjs
tests/conversation-export.test.ts
tests/request-augmentation.test.ts
tests/shell-policy.test.ts
wxt.config.ts
```

---

## 🚀 功能亮点

### 1. 子Agent系统
- **真正的多Agent协作**：主Agent可以调度多个子Agent并行工作
- **独立状态管理**：每个子Agent拥有完整的独立上下文
- **智能进度跟踪**：实时进度事件流，支持UI展示

### 2. 并行执行
- **批量调度**：多个子Agent调用合并为单次请求
- **智能路由**：自动区分并行和串行执行场景
- **状态隔离**：避免并发状态污染

### 3. 图片处理
- **完整支持**：从上传到Vision模式的完整链路
- **跨步传递**：图片file_id跨多个Agent步骤传递
- **自动重试**：上传失败自动重试

### 4. 调试能力
- **全链路trace**：每个工具调用的完整生命周期追踪
- **结构化日志**：会话、思考、响应的完整记录
- **文件持久化**：所有日志自动写入/tmp目录

### 5. PDF处理
- **学术图表提取**：专门针对学术论文的图表提取
- **智能识别**：自动检测和提取图表内容

---

## 📊 统计数据

| 指标 | 数值 |
|------|------|
| 总变更行数 | +3898 / -249 |
| 涉及文件数 | 30个修改 + 17个新增 |
| 新增测试文件 | 10个 |
| 代码增量 | ~3650行 |
| 最大单文件变更 | entrypoints/content.ts (+962行) |
| 新增核心模块 | subagent.ts (2065行) |

---

## 🔗 依赖关系

### 新增核心依赖链
```
content.ts
  ├─> inline-agent/loop.ts (并行执行引擎)
  │     └─> tool/subagent.ts (子Agent执行)
  │           └─> deepseek/image-upload.ts (图片上传)
  │
  ├─> tool/runtime.ts (工具运行时)
  │     ├─> tool/subagent.ts
  │     └─> utils/tool-trace.ts (追踪)
  │
  └─> utils/conversation-logger.ts (日志)
        └─> utils/safe-shell-write.ts
```

---

## 🎯 下一步建议

### 1. 代码审查重点
- **子Agent系统**：状态管理和并发安全
- **图片处理**：file_id传递的正确性
- **日志系统**：性能影响和磁盘使用

### 2. 测试覆盖
- 补充子Agent并发场景测试
- 添加图片上传边界情况测试
- 增加日志系统性能测试

### 3. 文档更新
- 更新用户文档，说明子Agent功能
- 添加开发者文档，说明调试工具使用
- 更新API文档，说明新增接口

### 4. 性能优化
- 评估批量调度的性能收益
- 优化日志写入频率
- 检查内存使用情况

---

## 📌 注意事项

### 兼容性
- **Breaking Changes**：部分接口有重大变更，需检查依赖
- **向后兼容**：大部分功能保持向后兼容

### 安全性
- **文件写入**：新增大量文件写入操作，需确保路径安全
- **Shell执行**：增强的Shell功能需严格参数验证

### 性能
- **日志开销**：全链路追踪可能带来性能开销
- **并发控制**：子Agent并发需要合理的限流策略

---

## 🏷️ 标签

`#架构升级` `#子Agent系统` `#并行执行` `#图片处理` `#调试增强` `#PDF提取` `#重大变更`

---

*文档生成时间：2025-06-15*
*基于Git状态：main分支，未推送更改*
