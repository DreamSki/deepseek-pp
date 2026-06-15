import type { ToolRiskLevel } from '../tool/types';

export const SHELL_MCP_SERVER_NAME = 'Shell Local';
export const SHELL_MCP_NATIVE_HOST = 'com.deepseek_pp.shell';

export const OFFICECLI_BIN_PATH = 'officecli';

export const SHELL_TOOL_NAMES = ['shell_exec', 'shell_status', 'python_status', 'python_exec', 'shell_read_image', 'shell_analyze_image', 'shell_upload_file'] as const;
export type ShellToolName = typeof SHELL_TOOL_NAMES[number];

export interface ShellToolSpec {
  name: ShellToolName;
  title: string;
  description: string;
  risk: ToolRiskLevel;
}

export const SHELL_TOOL_SPECS: readonly ShellToolSpec[] = [
  {
    name: 'shell_exec',
    title: '执行命令',
    description: '在本地系统执行 shell 命令，返回 stdout、stderr 和退出码。',
    risk: 'high',
  },
  {
    name: 'shell_status',
    title: '主机状态',
    description: '报告 Native Host 健康状态、平台、shell 类型和工作目录。',
    risk: 'low',
  },
  {
    name: 'python_status',
    title: 'Python 状态',
    description: '报告本机 Python 解释器、版本和可导入的快速验证库。',
    risk: 'low',
  },
  {
    name: 'python_exec',
    title: '执行 Python',
    description: '执行短 Python 代码，用于快速验证想法、复杂计算和小型数据处理。',
    risk: 'high',
  },
  {
    name: 'shell_read_image',
    title: '读取本地图片',
    description: '读取本地图片文件并返回 base64 编码数据，供模型分析图片内容。',
    risk: 'high',
  },
  {
    name: 'shell_analyze_image',
    title: '分析图片内容',
    description: '使用 Python/Pillow 对本地图片进行真实分析：尺寸、格式、色彩统计、主色调、亮度分布，并尝试 OCR 提取文字。返回图片的实际内容描述。分析图片内容时应优先使用此工具。',
    risk: 'high',
  },
  {
    name: 'shell_upload_file',
    title: '上传本地文件',
    description: '读取本地文件并上传到当前对话，支持 PDF、DOC/DOCX、XLSX/XLS、PPT/PPTX、图片、文本、代码等格式。利用 DeepSeek 原生文档解析能力处理复杂排版、表格和嵌套内容。',
    risk: 'high',
  },
] as const;
