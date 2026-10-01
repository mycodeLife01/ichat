# 文件上传限制放宽与上传进度计划

日期：2026-09-29

状态：三期均已实施（2026-09-29），真实栈验收未完成，见各期实施记录。决策 D1–D9 均已按推荐方案确认。

需求依据：用户反馈四类问题——大小限制过严（高清图片无法上传）、扩展名与内容校验过严、支持格式偏少、没有实时上传进度。调研中另外发现 EXIF 方向缺失、分片重试无退避、长截图不可用等问题。

架构依据：`docs/architecture/module-boundaries.md`、`docs/architecture/background-tasks.md`、`docs/architecture/frontend.md`、[统一文件上传交接](../handover/2026-08-01-unified-file-upload.md)、[文件上传性能交接](../handover/2026-08-09-file-upload-performance.md)、ADR 0001、0003、0006–0010。

## 0. 现状与证据

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 单文件大小上限 | 文本 2 MiB、图片 10 MiB、PDF 25 MiB、Office 20 MiB，模块常量，不可配置 | `app/services/files/formats.py:17-20`；capabilities 直接引用常量 `app/api/v1/capabilities.py` |
| 图片像素上限 | 单边 ≤ 8192、总像素 ≤ 20MP；解析与模型输入各校验一次 | `app/services/files/parsers.py:47-48`、`app/services/files/image_inputs.py:42-43` |
| 预览生成 | 原分辨率转 RGBA 后编码 WebP（quality 82、`method=6`）；同一 `preview` 同时用于界面展示和模型输入 | `app/services/files/parsers.py:535-538` |
| EXIF 方向 | 全仓库没有 `exif_transpose`；重新编码会丢弃 EXIF，但没有先按 EXIF 旋转像素，竖拍照片会变成横向 | `app/services/files/parsers.py:517-540` |
| 图片格式校验 | `image.format` 必须与扩展名对应的格式完全一致，否则报 `file_format_mismatch` | `app/services/files/parsers.py:524` |
| 文本编码 | 只接受 UTF-8 / UTF-16，GBK/GB18030 文本报 `invalid_text_encoding` | `app/services/files/parsers.py:445-462` |
| 策略选择 | worker 按原文件名的扩展名选择解析策略 | `app/services/files/processing.py:131` |
| 分类 | 由 `media_type` 和扩展名推导（图片 / PDF / Office / 文本） | `app/services/files/service.py:603-627` |
| 支持格式 | 19 种扩展名；前端按 capabilities 返回的 `allowed_extensions` 预先拦截，无扩展名文件直接拒绝 | `app/services/files/formats.py:23-43`、`frontend/src/files/useAttachmentUploads.ts:328-356` |
| 上传进度 | 单次 PUT 和分片 PUT 都用 `fetch`，拿不到上传进度；界面只显示状态文字 | `frontend/src/api/files.ts:71-155`、`frontend/src/files/utils.ts:76-90` |
| 分片重试 | 每片最多 3 次，失败后立即重试，没有等待 | `frontend/src/api/files.ts:129-145` |
| 消息附件总量 | 每条消息最多 5 个附件、总计 50 MiB | `app/core/config.py:185-186` |
| 解析子进程内存 | 512 MiB `RLIMIT_AS` | `app/services/files/parsers.py:59` |

### 图片耗时构成（6 MiB 图片，真实 R2）

数据来自 [文件上传性能交接](../handover/2026-08-09-file-upload-performance.md)：浏览器 PUT 1.3–3.3 s、确认 0.85–0.93 s、排队 0.85–1.1 s、worker 下载 1.5–11.8 s、ClamAV 0.01–0.43 s、解析 1.5–2.1 s、R2 写入 1.4–1.7 s（偶发 13.5 s），合计约 7.5–8.4 s。长尾主要来自 worker 与 R2 之间的网络。

### 预览编码本机基准（2026-09-29）

测试对象：一张合成的 20MP（5472×3648）JPEG，约 10 MiB。合成噪声图是最难压缩的情况，真实照片生成的预览会更小，但各方案之间的相对差距应类似。

| 方案 | 解码 + 编码耗时 | 预览大小 |
| --- | ---: | ---: |
| 现状：原分辨率 + `method=6` | 4.27 s | 7.03 MiB |
| 原分辨率 + `method=4` | 1.49 s | 7.03 MiB |
| 长边 2048 + `method=6` | 0.57 s | 0.39 MiB |
| 长边 2048 + `method=4` | 0.30 s | 0.41 MiB |

结论：缩小预览可以把大图的解析阶段从秒级降到亚秒级。对 6 MiB 的图，端到端约快 20%；worker 下载长尾和固定开销不受影响。

## 1. 已定决策

- **D1 单文件大小上限**：图片 30 MiB、原图 ≤ 80MP；PDF 50 MiB；Office 30 MiB；文本保持 2 MiB（2 MiB 文本已远超上下文预算，调大上限没有意义）。
- **D2 单条消息附件总量**：总大小从 50 MiB 提到 100 MiB；数量保持 5 个。
- **D3 扩展名与实际内容不一致**：以文件实际内容为准，只在同一大类内改用实际格式（图片之间：JPEG/PNG/WebP 等；Office 之间：DOCX/PPTX/XLSX）。跨大类（例如 `.txt` 实际是 PDF）仍拒绝，界面按 D9 只显示通用上传失败提示。
- **D4 未列出的扩展名（包括无扩展名文件）**：内容能按文本解码、不含 NUL、开头不是已知二进制文件头的，都按纯文本接收。同时补齐常用的文本和代码扩展名，方便界面显示正确的图标和分类。
- **D5 新增图片格式**：HEIC/HEIF（引入 `pillow-heif`）和 GIF（沿用“动图只取首帧”的逻辑）。本期不做 AVIF/BMP/TIFF，旧版 doc/xls/ppt 继续不支持。
- **D6 附件处理中先发送**：本期不做。等第二期上线后，看阶段指标再决定。
- **D7 浏览器端压缩超大图片**：不做，保留原件。
- **D8 预览缩放规则**：等比缩放，总像素 ≤ 4MP 且长边 ≤ 8192，不放大。原图的准入限制相应改为总像素 ≤ 80MP、单边 ≤ 16384，这样长截图（例如 1080×10000）可以接收，预览约 658×6085，文字仍可读。
- **D9 面向用户的上传错误提示**：不展示任何技术信息（错误码、格式/编码/像素/扫描等处理细节、存储或网络错误原文）。上传、确认、扫描、解析阶段的所有失败，界面统一显示一条通用提示 `文件上传失败，请稍后再试`。只保留三类在选择文件时的预检提示，因为用户能直接据此调整且不含技术细节：文件过大、类型不支持、单条消息超出数量或总大小限制。上传相关的面向用户提示统一用中文，这是对 `AGENTS.md` 中“面向用户的错误信息用英文”规则的明确例外（2026-09-29 用户确认）。具体错误码仍保留在 API 响应和服务端日志中，供排查使用。

## 2. 交付目标与成功标准

| 编号 | 成功标准 | 证明手段 |
| --- | --- | --- |
| S1 | 带 EXIF Orientation=6 的竖拍 JPEG，界面预览和发给模型的图像方向都正确 | 解析单测断言预览宽高互换；真实栈人工检查 |
| S2 | 上传过程中附件卡片显示连续推进的百分比；单次 PUT 和分片上传都有进度 | 前端单测（模拟 XHR progress 事件）；Chrome 实测上传 20 MiB 文件 |
| S3 | 分片失败后，重试之间有逐次加长、带随机抖动的等待 | 前端单测：注入假计时器，断言重试间隔 |
| S4 | 预览总像素 ≤ 4MP，解析阶段耗时明显低于现状（第一期）；48MP、25 MiB 照片可以上传成功（第二期） | 解析单测；真实 R2 smoke 记录 `parse` 与 `preview_write` 阶段耗时 |
| S5 | 1080×10000 长截图可以上传，预览约为 658×6085（第二期放宽单边上限后） | 解析单测 |
| S6 | `image-v1` 的历史图片仍能作为模型输入；新图片为 `image-v2`；整个计划只升这一次版本 | `image_inputs` 单测覆盖两个版本；回放一条历史图片消息 |
| S7 | 扩展名是 `.jpg`、内容是 PNG 的文件成功按 PNG 处理；`.txt` 内容是 PDF 的文件被拒绝，界面显示通用上传失败提示 | 解析 / 处理单测 |
| S8 | GB18030 编码的 txt 和 csv 能成功解析，并带 `text_encoding_normalized` 警告 | 解析单测 |
| S9 | `Dockerfile`、`.env`、`main.rs` 等可以上传并按文本解析；二进制文件（比如 exe）改名成 `.txt` 后仍被拒 | 单测；前端单测覆盖预检放宽后的行为 |
| S10 | HEIC 和 GIF 能上传并生成预览；GIF 带首帧警告 | 解析单测（需要 HEIC 样本）；真实栈 smoke |
| S11 | 各类大小上限通过 `Settings` 配置，capabilities 返回配置值，前端预检随之生效 | 配置单测；capabilities 接口测试 |
| S12 | 任何上传或处理失败，附件卡片和 toast 都只显示通用提示，不出现错误码、处理细节或服务端/存储返回的原文 | 前端单测：遍历全部已知错误码、未知错误码、服务端 `message` 和 PUT 抛出的异常，断言显示文本只能是通用提示或三类预检提示之一 |

## 3. 分期与改动清单

### 第一期：前端体验与图像解析 `image-v2`

不改上传接口协议，可以单独上线。本期所有改变预览输出的图像解析规则合并为一个版本 `image-v2`，后续各期不再改变已有格式的预览输出，也不再升版本。

1. **图像解析 `image-v2`**（S1、S4、S6）：以下三项一起改，只升一次版本。
   - EXIF 方向：`image.load()` 之后、缩放之前调用 `ImageOps.exif_transpose`，宽高以旋转后的为准。
   - 预览缩放：JPEG 先用 `Image.draft()` 按目标尺寸解码以节省内存，再按“总像素 ≤ 4MP、长边 ≤ 8192、不放大”等比缩放（`Image.LANCZOS`），编码改用 `method=4`。缩放后的预览宽高写入 `metadata` 的 width/height；原图宽高（旋转后）另存为 `original_width/original_height`。
   - 版本兼容：`extractor_version` 升到 `image-v2`；`image_inputs.py` 接受版本集合 `{image-v1, image-v2}`；宽高一致性校验对比快照与资产中记录的预览宽高；模型输入侧的像素上限改为校验预览（≤ 4MP 与长边 ≤ 8192），不再使用原图上限。历史资产不回填。
   - 本期原图准入限制保持 20MP / 单边 8192 不变，放宽在第二期做。
2. **上传进度**（S2）：`putFileToUpload` 与 `putMultipartFile` 改用 `XMLHttpRequest`，读取 `upload.onprogress`；新增 `onProgress(loadedBytes, totalBytes)` 回调，分片上传按分片汇总，重试时先扣掉该分片已计入的字节。`fetchImpl` 注入点改为可注入的 XHR 工厂，保持可测试。取消沿用现有 `AbortSignal`（映射到 `xhr.abort()`）。
3. **进度展示**（S2）：`DraftAttachment` 增加 `progress`（只存在于内存，不持久化，刷新后恢复轮询时没有进度）。`AttachmentCard` 在 `uploading` 阶段显示百分比进度，在 `pending/queued/processing` 阶段显示不确定进度并保留状态文字。进度条放在卡片内部已有的区域里，不改变卡片高度。
4. **分片重试退避**（S3）：第 2、3 次尝试前分别等待约 500 ms、1000 ms，并加 0–50% 的随机抖动；等待期间可以被取消。
5. **通用错误提示**（D9、S12）：
   - `errorLabel` 删掉按错误码区分的文案表，失败状态一律返回通用提示 `文件上传失败，请稍后再试`。
   - `AttachmentCard` 不再优先显示服务端状态里的 `message`（`draftFromUpload` 写入的 `error_message`），也不显示 `putFileToUpload` 抛出的异常原文。
   - `useAttachmentUploads` 的 toast 与卡片使用同一条通用提示，即现有常量 `FILE_UPLOAD_FAILURE_MESSAGE`（`文件上传失败，请稍后再试`）。
   - 选择文件时的预检提示只保留三类并改为中文：文件过大、类型不支持、超出单条消息的数量或总大小限制。取消失败等交互提示保持现状。
   - 错误码仍保留在 `DraftAttachment.error_code` 和网络响应中，只是不展示。

#### 第一期实施记录（2026-09-29）

实施时与上文清单的差异和补充：

- **MPO**：带多张图片的 JPEG（很多手机直出照片）会被 Pillow 识别为 `MPO`，此前统一按 `file_format_mismatch` 拒绝。现在 `.jpg/.jpeg` 同时接受 `JPEG` 和 `MPO`，只取主图，`frame_count` 记为 1，不产生动图警告。
- **损坏的 EXIF**：读取 EXIF 失败时按“没有方向信息”处理，不因元数据损坏而拒绝图片。
- **`image_inputs` 的尺寸校验**：模型输入侧继续沿用 8192 边长和 20MP 像素的上限，作为宽松的合理性检查，没有改成预览上限（4MP）。v1 快照的预览可能超过 4MP，收紧会让它们无法回放。
- **进度展示**（2026-09-29 用户确认，参照 ChatGPT）：只用圆形进度指示，不显示百分比文字。创建上传会话（`creating`）时转圈；字节传输（`uploading`）时圆环按实时进度推进；确认请求进行中圆环停在满格；服务端处理（`pending/queued/processing`）没有可度量的进度，改为与圆环同尺寸的不确定转圈弧线（2026-10-01 调整，原先停在满格）；处理完成（`succeeded`）后移除指示器。发送门槛不变，仍需附件处理完成。
- **可测试性**：存储 PUT 的注入点改为 `StoragePut` 函数（`useAttachmentUploads` 的 `storagePut` 选项），默认实现是 `xhrStoragePut`；分片退避的等待函数和随机数也可以注入。
- **未完成的验证**：本机没有 PostgreSQL（Docker 未运行），`tests/api/test_vision_conversations.py` 等依赖数据库的测试没有在本地运行，需要由 CI 或本地数据库补跑；真实 Chrome 上传 20 MiB 的进度与卡片高度检查也尚未进行。

### 第二期：放宽限制与校验

1. **上限配置化**（S11）：`Settings` 新增 `files_text_max_bytes`、`files_image_max_bytes`（30 MiB）、`files_pdf_max_bytes`（50 MiB）、`files_office_max_bytes`（30 MiB）、`files_image_max_pixels`（80MP）、`files_image_max_edge`（16384）；`files_max_message_bytes` 默认值改为 100 MiB。`FormatPolicy.max_bytes` 改为从配置读取（策略表保留格式与分类，上限在运行时注入）；capabilities 返回配置值；`.env.example` 与 `docs/deployment.md` 同步。
2. **放宽原图准入**（S4、S5）：解析侧的原图限制改为读取 `files_image_max_pixels`（80MP）与 `files_image_max_edge`（16384）。预览规则沿用第一期，不改变预览输出，`extractor_version` 保持 `image-v2`。
3. **内存预算**：80MP 原图解码后约 320 MiB（RGBA），加上 `draft` 与缩放的中间对象，逼近 512 MiB 的 `RLIMIT_AS`。实施时先用 80MP JPEG/PNG 实测子进程峰值内存；PNG 不能用 `draft`，如果超出限制，就把解析子进程内存上限提到 1 GiB，并确认 file-worker 容器内存留有余量。
4. **按内容识别格式**（S7）：worker 在解析前嗅探文件头（PNG、JPEG、WebP、GIF、HEIC `ftyp`、PDF、ZIP 中 `[Content_Types].xml` 声明的 OOXML 类型）。
   - 实际格式与扩展名属于同一大类（图片 / Office）：改用实际格式的策略解析，并按实际格式重新检查大小上限；`media_type` 和分类以实际格式为准，原文件名不变，并记录 `format_corrected` 警告。
   - 跨大类：拒绝，错误码 `file_format_mismatch`（只用于日志和排查，界面显示通用提示）。
   - 策略选择从 `policy_for_filename` 改为“扩展名选初始策略 + 文件头修正”。`file_category_values` 对 Office 的判断不能再只看扩展名，要改为使用修正后的格式。
5. **文本编码兜底**（S8）：UTF-8（含 BOM）和 UTF-16 失败后，依次尝试 `gb18030`、`big5`；成功则带 `text_encoding_normalized` 警告。保留 NUL 检查和非文本文件头检查。
6. **纯文本兜底与扩展名补齐**（S9）：
   - 补充 html、htm、css、scss、xml、log、toml、ini、cfg、conf、env、sh、bash、zsh、ps1、bat、c、h、cpp、hpp、cc、cs、rs、rb、php、kt、kts、swift、scala、lua、r、pl、tsx、jsx、vue、svelte、graphql、proto、tex、diff、patch 等文本策略。
   - 新增通用文本策略 `text_fallback`：未知扩展名和无扩展名文件在创建阶段按文本上限放行，由 worker 的文本解析（编码、NUL、二进制文件头检查）最终判定。
   - capabilities 增加 `accepts_unlisted_text: true`，前端预检据此放行未列出的扩展名，并按文本上限检查大小。
   - `<input accept>` 去掉，或只作为文件选择器里的提示，避免系统选择器把未列出的文件置灰。

### 第三期：新格式

1. **HEIC/HEIF**（S10）：引入 `pillow-heif` 并在解析子进程中注册；新增 `heic`/`heif` 策略，归入图片大类，走与其他图片相同的 `image-v2` 解码、缩放、重新编码流程（新格式不影响已有格式的输出，不升版本）；原件保存为 `image/heic`，预览仍是 WebP。需要确认 ClamAV 能处理该格式（至少不误报、不超时），并在 Docker 镜像中验证依赖的 libheif 可用。
2. **GIF**（S10）：新增 `gif` 策略，复用动图只取首帧的逻辑与 `animated_image_first_frame` 警告。

#### 第二、三期实施记录（2026-09-29）

两期在同一分支一起实施。与上文清单的差异和补充：

- **上限注入**：`formats.py` 新增不可变的 `FileLimits`（`from_settings()`、`max_bytes(category)`、`category_max_bytes()`），`FormatPolicy` 只保留 `category`（image/pdf/office/text）。API 创建会话、file-worker 任务、解析子进程都使用同一份 `FileLimits`；解析子进程只有最小环境变量、读不到 `Settings`，因此上限以 JSON 形式通过 argv 传入 `parser_worker.py`。
- **内存实测与缩放顺序**：80MP 原图在第一期的“先转 RGBA 再缩放”顺序下，RGB PNG 子进程峰值约 1060 MiB。改为 RGB/RGBA/L 模式直接在原模式下缩放（带 `reducing_gap=3.0`）、缩放后再转 RGBA，其他模式仍先转 RGBA；实测峰值 RGB PNG 459 MiB、RGBA PNG 约 755–760 MiB、JPEG 186 MiB。预览尺寸规则不变，仍为 `image-v2`。解析子进程 `RLIMIT_AS` 提到 1 GiB；file-worker 以并发 2 运行，两份 compose 中容器 `mem_limit` 从 1g 提到 3g，部署文档已同步。
- **按内容识别格式**：嗅探在解析子进程内完成（`sniff_format`），不在 API 读字节。父进程校验子进程结果时，只接受同一大类（图片 / Office）内的格式修正，跨大类的结果按 `parser_failed` 处理，防止子进程被利用后借此改写分类。OOXML 嗅探只读取不超过 1 MiB 的 `[Content_Types].xml`，只有恰好匹配一种主类型时才修正，否则沿用原有的 `ooxml_type_mismatch` 检查。修正后的 `media_type` 决定 `file_category_values` 的 Office 判断。
- **纯文本兜底**：没有单独新建 `text_fallback` 格式，未知扩展名和无扩展名文件直接复用 TXT 策略（`TEXT_FALLBACK_POLICY`），新增的文本和代码扩展名也都走 TXT 策略，统一以 `text/plain` 存储。前端预检使用与后端一致的扩展名解析（无点号视为无扩展名），`accepts_unlisted_text` 为真时放行未列出的扩展名并按文本上限检查；`<input accept>` 已去掉。前端分类集合同步补齐，只影响图标和分类显示。
- **编码兜底的局限（2026-10-01 已解决）**：`gb18030` 和 `big5` 的字节范围重叠，大多数 Big5 文件也能被 `gb18030` 严格解码（得到乱码）。现在两者都能严格解码时，用 `charset-normalizer` 在这两个候选内按乱码程度排序，分数相同（通常是极短文本）时仍优先 `gb18030`。
- **HEIC**：`pillow-heif>=1.8.0` 在解析子进程内按需注册，Pillow 格式名为 `HEIF`。pillow-heif 解码时已按 EXIF 方向旋转，并把方向改写为 1，因此不会与 `exif_transpose` 重复旋转；单测用竖向样本断言预览为正向的 32×64。`.heic`/`.heif` 原件保存为 `image/heic`，uv.lock 已包含 manylinux_2_28 wheel。
- **GIF**：多帧 GIF 取首帧并带 `animated_image_first_frame_only` 警告。
- **警告文案**：前端新增 `format_corrected` 的说明文案。
- **长截图**：1080×10000 的预览实测为 657×6085（向下取整）。
- **上线顺序修正**：file-worker 应先于或与 API 同时上线。如果 API 先放宽上限，旧 file-worker 会拒绝新放行的大文件，用户看到的只是通用失败提示。修改上限时，API（经 `.env`）与 file-worker（显式 `environment`）的变量必须保持一致。
- **未完成的验证**：
  - 本机 Docker/PostgreSQL 未运行，`pytest` 中依赖数据库的用例报连接错误，没有实际执行，其中包括已更新期望值的 capabilities 接口测试。
  - ClamAV 对 HEIC 的扫描表现、Docker 镜像中 pillow-heif/libheif 是否可用，都没有验证。
  - 第 6 节的真实栈验收（R2 + ClamAV + file-worker 各类样本、阶段耗时、`image-v1` 回放、Chrome 20 MiB 进度）都没有进行。

## 4. 不在本期范围

- 附件处理中先发送（D6）、浏览器端压缩（D7）、AVIF/BMP/TIFF、旧版 Office 格式、RTF/EPUB/ODT。
- 长截图切片后再发给模型：模型服务商自己也会缩放图片，超长图对模型的可读性由服务商决定；本期只保证界面显示可读。
- 刷新页面后续传：维持 [文件上传性能交接](../handover/2026-08-09-file-upload-performance.md) 中的既有取舍。
- 改善 worker 与 R2 之间的网络（部署位置）：属于部署决策，另行评估。

## 5. 兼容与上线

- 第一期上线顺序：LLM worker（接受 `image-v2`）→ file-worker（产出 `image-v2`）→ 前端。LLM worker 必须先于 file-worker 上线，否则新图片会因版本不匹配被拒。
- 第二期上线顺序：API（配置与 capabilities）→ file-worker（放宽准入、格式修正、编码兜底）→ 前端（预检放宽）。不涉及版本变化，LLM worker 无需改动。
- 回滚：前端和 capabilities 可以直接回滚；file-worker 回滚到第一期之前会停止产出 `image-v2`，但已产出的 `image-v2` 资产依赖 LLM worker 继续接受该版本，所以 LLM worker 的兼容代码不回滚。
- 历史数据不迁移、不回填。

## 6. 验证

```bash
ruff check app tests
mypy app
pytest
pnpm --dir frontend test -- --run
pnpm --dir frontend exec tsc --noEmit
docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
```

真实栈验收（R2 + ClamAV + file-worker）：

- 48MP / 25 MiB JPEG、1080×10000 长截图 PNG、竖拍 EXIF JPEG、改名 PNG→JPG、GB18030 CSV、`Dockerfile`、HEIC、GIF 各上传一次。
- 记录 `parse`、`preview_write`、`r2_promote` 阶段耗时，与第 0 节的基线对比。
- 回放一条 `image-v1` 历史图片消息，确认模型调用成功。
- 用 Chrome 上传 20 MiB 文件，确认进度连续、卡片高度没有跳动。
