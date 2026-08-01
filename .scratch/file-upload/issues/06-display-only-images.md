Type: feat
Status: ready-for-agent
Blocked by: 03

# 仅展示的图片附件

## 目标

支持 JPG/JPEG、PNG 和静态 WebP 上传、预览与下载，同时明确本期模型不理解图片：图片
字节、URL、OCR 或视觉描述都不得进入 provider context。

## 交付范围

1. capabilities、前后端 allowlist 加入 jpg/jpeg/png/webp。单文件最大 10 MiB，最长边
   8192、总像素最多 2,000 万；完整解码后验证真实格式，拒绝动画、多帧、损坏内容、
   扩展名伪装和像素炸弹。
2. 原件经过 ClamAV 后保存到私有 canonical bucket；生成去元数据、固定安全编码策略的
   preview 派生物。FileObject 分别记录 original 与 preview 的媒体类型、大小、hash 和 key。
3. 模型消息为每个图片生成 `AttachmentNoticeBlock`，只含安全文件名、类型和“当前不可读取”
   的事实。provider adapter 不接收图片字节、data URL、签名 URL、OCR 或虚构描述。
4. 纯图片消息不满足发送条件；文字+图片或文档+图片允许发送，并参与每消息五文件与
   50 MiB 限制，但图片不消耗文档 token 输入预算。
5. UI 只对图片提供 preview；点击下载获取原件。preview 使用五分钟 inline 签名 URL，
   download 使用五分钟 attachment URL；API 不代理字节并正确转义响应头。
6. output manifest、取消竞态、失败清理、配额和 detached 生命周期覆盖原件与派生物。

## 验收

- JPG/JPEG、PNG、静态 WebP 均完成上传→ready→预览→文字+图片发送→下载原件链路。
- 测试覆盖动画 WebP、多帧、超边长、超像素、解码失败、格式伪装和 EXIF/元数据移除。
- provider fake 断言只收到 AttachmentNoticeBlock，任何请求与 transcript 都不含图片字节、
  URL、OCR 或视觉描述；纯图片发送稳定拒绝。
- preview/download 授权、Content-Disposition、安全文件名和五分钟过期均有测试。
- canonical 任一步故障、取消或数据库提交失败后，original/preview 都可由 manifest 幂等清理。
- 后端和前端全套检查通过。

## 非目标

- ImageBlock、视觉模型、OCR、自动图片描述和 GIF 均不在本票范围。
