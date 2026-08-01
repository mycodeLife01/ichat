Type: feat
Status: completed
Blocked by: 03

# PDF 文本提取纵向切片

## 目标

支持 PDF 原件从安全上传、文本提取到 DocumentBlock 和消息使用的完整路径，不引入 OCR、
页面渲染或视觉理解。

## 交付范围

1. PDF 最大 25 MiB、最多 200 页；验证真实 PDF，拒绝扩展名伪装、损坏、加密或密码保护
   文件，以及超过复杂度或处理资源限制的文件。
2. 在受限解析子进程中只提取可选择的可见正文，保留稳定页边界标记；不处理批注、附件、
   脚本、表单动作、文档属性或嵌入对象，不渲染页面、不做 OCR。
3. 存在部分可用语义内容时允许 ready，持久化稳定 warning 并同时展示在 UI 和
   DocumentBlock；完全无可提取文本时 rejected。
4. 原件和派生文本作为独立 FileObject 进入 output manifest、删除补偿、下载授权和配额
   生命周期；派生文本不提供直接下载。
5. 完整提取内容参与 128k 目标 turn 预算并快照到 transcript；超限拒绝发送而不截断、
   摘要或抽样。

## 验收

- 正常、多页、部分可读、空文本、扫描件、加密、损坏和超 200 页 fixture 有 golden tests；
  扫描件/空文本明确 rejected 而不是静默 ready。
- 页面标记、warning、extractor version、hash 与全文经过 provider 和 transcript round-trip
  后保持稳定。
- 解析超时/资源超限为永久策略拒绝；scanner/R2 等暂时故障才进入 30 秒/5 分钟重试。
- UI 显示元数据、warning 与原件下载，不增加 PDF 阅读器或预览。
- 受控 corpus 不触发网络、脚本、附件或外部引用；日志无文件名、正文和原始 parser 异常。
- 后端和前端全套检查通过。
