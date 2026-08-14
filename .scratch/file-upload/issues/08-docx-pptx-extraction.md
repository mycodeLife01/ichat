Type: feat
Status: completed
Blocked by: 03

# DOCX 与 PPTX 安全文本提取

## 目标

建立可复用的安全 OOXML 容器检查，并纵向支持 DOCX、PPTX 的可见语义文本进入消息和
模型上下文。

## 交付范围

1. DOCX/PPTX 单文件最大 20 MiB；验证 ZIP 容器内部类型。解压后总大小最大 100 MiB、
   entry 最多 10,000，并拒绝路径穿越、嵌套压缩、异常压缩比、XXE、外部引用、加密或
   密码保护内容。
2. DOCX 提取正常可见正文和表格，最多 100,000 个可提取节点；排除批注、已删除修订、
   隐藏内容、文档属性、宏和交互动作。
3. PPTX 最多 200 张可见幻灯片，按稳定 slide 顺序提取可见文字；排除隐藏 slide、
   speaker notes、批注、交互动作、嵌入对象和媒体内容。
4. 部分存在可提取语义内容时 ready 并产生稳定 warning；零文本 rejected。原件与派生文本
   进入 manifest、FileObject、DocumentBlock、transcript、下载和生命周期流程。
5. UI 仅展示文件卡片、格式、大小、warning 与原件下载，不渲染 Office 页面。

## 验收

- DOCX 正文/表格与 PPTX 可见 slide 具有 golden tests；隐藏 slide、notes、comments、
  删除修订、属性和外部对象不会出现在派生内容。
- 覆盖错误内部类型、ZIP bomb、路径穿越、嵌套压缩、XXE、加密、损坏、节点/slide 上限。
- 正常、部分可读和零文本终态明确，warning 同时出现在 UI、DocumentBlock 与 transcript。
- 受限子进程的 120/180 秒限制和资源终止路径可复现，且不会污染 file-worker 主进程。
- DOCX/PPTX 可分别完成上传→ready→发送→provider→历史回放→下载。
- 后端和前端全套检查通过。
