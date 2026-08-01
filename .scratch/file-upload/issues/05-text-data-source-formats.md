Type: feat
Status: ready-for-agent
Blocked by: 03

# 文本、数据与源码格式纵向扩展

## 目标

在 TXT 已打通的用户路径上增加 MD、CSV、JSON、YAML/YML、PY、JS、TS、GO、JAVA、SQL，
并保持它们从上传、安全处理到 DocumentBlock、下载和 UI 卡片的完整行为一致。

## 交付范围

1. capabilities、前后端 allowlist 和真实内容识别精确加入上述扩展名；每个文件最大 2 MiB，
   浏览器 MIME 只作初筛，扩展名与识别出的内容类别必须相容。
2. 所有格式只接受 UTF-8/UTF-8 BOM，拒绝 NUL 与严格解码失败；派生文本移除 BOM、换行
   统一 LF，原件保持不变。
3. CSV 最多 100,000 行、每行最多 256 列；计数过程有明确资源上限。CSV、JSON、YAML
   和源码无需语法有效，只作为低信任文本，不反序列化为业务对象、不执行代码。
4. 每类文件生成稳定 DocumentBlock 元数据和完整派生文本，参与 128k 目标 turn 预算、
   transcript 快照、编辑、重新生成和下载。
5. UI 根据格式显示文件类型、大小、状态、warning 和下载按钮，不增加浏览器内阅读器。

## 验收

- 每个扩展名至少有一个上传→ready→发送→模型→transcript 回放的集成样例。
- 覆盖 BOM、CRLF、非法 UTF-8、NUL、空文件、无效 JSON/YAML/代码、CSV 行列边界及超限。
- 扩展名伪装和 allowlist 外格式在进入 ready 前被稳定拒绝，错误码不暴露文件内容。
- 多格式组合仍遵守五附件、50 MiB、128k token 与原子绑定规则。
- 普通 CI 不执行用户代码或解析为可触发对象构造的业务结构；后端和前端检查全绿。
