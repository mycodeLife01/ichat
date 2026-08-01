# 在调用 provider 前由 iChat 提取文档

本期所有模型可消费附件都由 iChat 的隔离文件处理链路生成 `DocumentBlock`，provider adapter 只把同一份完整派生文本投影到各自消息格式；系统不调用 provider 原生 Files API，也不把附件原件上传给第三方。该决定让解析结果、transcript 和 provider 切换保持一致，并把文件内容的数据出境限制为一次 Run 实际需要的派生文本，代价是 iChat 自行承担 PDF、Office、文本与代码格式的解析、安全更新和 token 成本；未来采用 provider 原生文件能力必须作为新的 capability 与数据出境决策显式引入。
