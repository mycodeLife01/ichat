# Provider/Worker Bug 修复计划

> **给 agentic workers：** 执行本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。按项目规则，默认直接在当前分支开发，不创建或切换 git worktree。

**目标：** 修复 provider/worker 最近实现中的 DeepSeek thinking 配置失效、取消无法及时打断阻塞 stream、terminal 状态竞态覆盖这三个 bug，并补齐对应回归测试。

**架构：** DeepSeek adapter 负责把配置显式映射到 HTTP payload；worker executor 负责把数据库中的 `cancelling` 状态转成对 provider stream task 的主动取消；run lifecycle service 负责在数据库锁内做 terminal 状态幂等转换，避免多 terminal event 或状态回写。保持现有 provider 抽象、PostgreSQL queue、worker loop 边界不变。

**技术栈：** Python 3.12、SQLAlchemy 2.0 async、httpx、FastAPI、pytest-asyncio、uv、ruff、mypy。

---

## 文件结构

修改文件：

- `app/providers/deepseek.py`：在请求 payload 中显式设置 DeepSeek thinking 开关。
- `tests/providers/test_deepseek_adapter.py`：验证 thinking payload 跟随配置变化。
- `app/worker/executor.py`：用独立 task 运行 provider stream；取消事件先完成时主动 cancel stream task；成功物化前检查 terminal transition 是否真的成功。
- `tests/worker/test_executor.py`：增加阻塞 stream 取消回归测试。
- `app/services/runs/lifecycle.py`：terminal transition 使用行锁和状态 guard，返回是否实际完成转换。
- `tests/services/runs/test_lifecycle.py`：覆盖 terminal transition 幂等性和状态 guard。

不修改文件：

- `app/worker/main.py`：worker polling/recovery 调度本身不变。
- `app/services/runs/service.py`：`append_run_event()` 递增 seq 行为不变。
- `app/services/conversations/service.py`：只由 executor 根据 succeeded transition 结果决定是否调用 `materialize_assistant_message()`。

---

## Task 1: 修复 DeepSeek thinking 配置失效

**Files:**
- Modify: `app/providers/deepseek.py`
- Modify: `tests/providers/test_deepseek_adapter.py`

- [ ] **Step 1: 写失败测试**

在 `tests/providers/test_deepseek_adapter.py` 追加以下测试。测试只检查请求 payload，不依赖真实 DeepSeek。

```python
async def test_deepseek_provider_disables_thinking_when_config_false() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": "Hi"},
                                "finish_reason": None,
                            }
                        ],
                    },
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                ]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        )
    ]

    assert chunks[0] == TextDelta(text="Hi")
    assert captured_payload["thinking"] == {"type": "disabled"}


async def test_deepseek_provider_enables_thinking_when_config_true() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                ]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": True})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        )
    ]

    assert isinstance(chunks[0], Finish)
    assert captured_payload["thinking"] == {"type": "enabled"}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
uv run pytest tests/providers/test_deepseek_adapter.py::test_deepseek_provider_disables_thinking_when_config_false tests/providers/test_deepseek_adapter.py::test_deepseek_provider_enables_thinking_when_config_true -v
```

Expected: 两个测试都 FAIL，错误类似 `KeyError: 'thinking'`。

- [ ] **Step 3: 实现最小修复**

在 `app/providers/deepseek.py` 的 `payload` 中加入 `thinking` 字段：

```python
        payload = {
            "model": model,
            "stream": True,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "thinking": {
                "type": "enabled" if self._settings.deepseek_thinking_enabled else "disabled"
            },
        }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
uv run pytest tests/providers/test_deepseek_adapter.py -v
```

Expected: `tests/providers/test_deepseek_adapter.py` 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/providers/deepseek.py tests/providers/test_deepseek_adapter.py
git commit -m "fix: honor deepseek thinking setting"
```

---

## Task 2: 修复取消无法及时打断阻塞 provider stream

**Files:**
- Modify: `app/worker/executor.py`
- Modify: `tests/worker/test_executor.py`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/test_executor.py` 追加以下测试。该测试构造一个先输出 partial delta、随后永久等待的 provider；当前实现会卡在 provider stream，直到 `wait_for` 超时。

```python
async def test_execute_run_cancels_blocked_provider_stream_promptly(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    class BlockingProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            yield TextDelta(text="partial")
            await asyncio.Event().wait()
            yield Finish(finish_reason="stop")  # pragma: no cover

    async def flip_to_cancelling_after_delta() -> None:
        for _ in range(50):
            await asyncio.sleep(0.02)
            async with session_factory() as session:
                event = await session.scalar(
                    select(RunEvent.id).where(
                        RunEvent.run_id == run_id,
                        RunEvent.type == "text_delta",
                    )
                )
                if event is None:
                    continue
                run = await session.get(Run, run_id)
                assert run is not None
                run.status = "cancelling"
                await session.commit()
                return
        raise AssertionError("text_delta was not persisted before timeout")

    cancel_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})
    flip_task = asyncio.create_task(flip_to_cancelling_after_delta())
    try:
        await asyncio.wait_for(
            execute_run(
                session_factory=session_factory,
                run_id=run_id,
                worker_id="worker-x",
                settings=cancel_settings,
                resolve_provider=make_resolver(BlockingProvider()),
            ),
            timeout=2.0,
        )
    finally:
        await flip_task

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [
            "run_started",
            "text_delta",
            "run_cancelled",
        ]

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        assert [message.role for message in messages] == ["user"]
```

- [ ] **Step 2: 运行测试确认失败**

```bash
uv run pytest tests/worker/test_executor.py::test_execute_run_cancels_blocked_provider_stream_promptly -v
```

Expected: FAIL with `TimeoutError`。

- [ ] **Step 3: 把 provider stream 包成可取消 task**

在 `app/worker/executor.py` 中新增 helper。放在 `_StreamOutcome` 定义之后、`_run_provider_stream()` 之前，避免类型注解引用尚未定义的类。

```python
async def _run_provider_stream_until_done_or_cancelled(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    cancel_event: asyncio.Event,
) -> _StreamOutcome:
    stream_task = asyncio.create_task(
        _run_provider_stream(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            provider_model=provider_model,
            messages=messages,
            cancel_event=cancel_event,
        )
    )
    cancel_task = asyncio.create_task(cancel_event.wait())
    try:
        done, pending = await asyncio.wait(
            {stream_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancel_task in done and cancel_event.is_set() and not stream_task.done():
            stream_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stream_task
            async with session_factory() as session:
                delta_persisted = await run_has_text_delta(session, run_id=run_id)
            return _StreamOutcome(
                status="cancelled",
                before_first_delta=not delta_persisted,
                delta_persisted=delta_persisted,
            )
        return await stream_task
    finally:
        for task in (stream_task, cancel_task):
            if not task.done():
                task.cancel()
        for task in (stream_task, cancel_task):
            with contextlib.suppress(asyncio.CancelledError):
                await task
```

- [ ] **Step 4: 在 `execute_run()` 中使用 helper**

把 `execute_run()` 里直接调用 `_run_provider_stream(...)` 的代码替换为：

```python
            outcome = await _run_provider_stream_until_done_or_cancelled(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                cancel_event=cancel_event,
            )
```

- [ ] **Step 5: 保持 cancelling 后 lease 仍被短暂续租**

把 `_heartbeat_loop()` 中检测到 cancelling 后直接 `return` 的逻辑改成只设置事件，直到 `execute_run()` 的 `finally` 取消 heartbeat task：

```python
            if cancelling:
                cancel_event.set()
```

不要在这段后面 `return`。这样取消清理期间 lease 不会立刻停止续租，降低 recovery 抢先标 failed 的窗口。

- [ ] **Step 6: 运行测试确认通过**

```bash
uv run pytest tests/worker/test_executor.py::test_execute_run_cancels_blocked_provider_stream_promptly -v
```

Expected: PASS。

- [ ] **Step 7: 运行 worker executor 测试**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: `tests/worker/test_executor.py` 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add app/worker/executor.py tests/worker/test_executor.py
git commit -m "fix: cancel blocked provider streams promptly"
```

---

## Task 3: 修复 terminal 状态转换竞态和重复 terminal event

**Files:**
- Modify: `app/services/runs/lifecycle.py`
- Modify: `app/worker/executor.py`
- Modify: `tests/services/runs/test_lifecycle.py`
- Modify: `tests/worker/test_executor.py`

- [ ] **Step 1: 写 lifecycle 失败测试**

在 `tests/services/runs/test_lifecycle.py` 中导入 `mark_run_cancelled`：

```python
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    is_cancelling,
    mark_run_cancelled,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    recover_expired_runs,
    renew_lease,
    run_has_text_delta,
)
```

追加以下测试：

```python
async def test_mark_run_succeeded_noops_when_run_is_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="cancelling")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        changed = await mark_run_succeeded(
            session,
            run_id=run_id,
            usage=None,
            provider_request_id=None,
        )
        await session.commit()

    assert changed is False

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelling"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events == []


async def test_terminal_transition_noops_when_run_already_terminal(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run_id = run.id
        await mark_run_failed(
            session,
            run_id=run_id,
            code="lease_expired",
            message="worker lease expired",
        )
        await session.commit()

    async with session_factory() as session:
        changed = await mark_run_cancelled(session, run_id=run_id)
        await session.commit()

    assert changed is False

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "failed"
        assert updated.error_code == "lease_expired"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_failed"]
```

- [ ] **Step 2: 运行 lifecycle 测试确认失败**

```bash
uv run pytest tests/services/runs/test_lifecycle.py::test_mark_run_succeeded_noops_when_run_is_cancelling tests/services/runs/test_lifecycle.py::test_terminal_transition_noops_when_run_already_terminal -v
```

Expected: FAIL，因为当前 transition 函数返回 `None` 且无条件写 terminal 状态和 event。

- [ ] **Step 3: 给 terminal transition 加状态 guard**

在 `app/services/runs/lifecycle.py` 中新增常量和 helper：

```python
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")
SUCCEEDED_FROM_STATUSES = ("started", "streaming")
FAILED_FROM_STATUSES = ("started", "streaming", "cancelling")
CANCELLED_FROM_STATUSES = ("queued", "started", "streaming", "cancelling")


async def _get_run_for_update(session: AsyncSession, *, run_id: int) -> Run:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    return run
```

把 `mark_run_succeeded()` 签名和开头改成返回 `bool`：

```python
async def mark_run_succeeded(
    session: AsyncSession,
    *,
    run_id: int,
    usage: dict[str, Any] | None,
    provider_request_id: str | None,
) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in SUCCEEDED_FROM_STATUSES:
        return False
```

函数末尾在 append event 后返回：

```python
    return True
```

把 `mark_run_failed()` 签名和开头改成：

```python
async def mark_run_failed(
    session: AsyncSession,
    *,
    run_id: int,
    code: str,
    message: str,
) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in FAILED_FROM_STATUSES:
        return False
```

函数末尾返回：

```python
    return True
```

把 `mark_run_cancelled()` 签名和开头改成：

```python
async def mark_run_cancelled(session: AsyncSession, *, run_id: int) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in CANCELLED_FROM_STATUSES:
        return False
```

函数末尾返回：

```python
    return True
```

- [ ] **Step 4: 更新已有 lifecycle 测试断言**

在 `tests/services/runs/test_lifecycle.py` 中，已有调用 terminal transition 的测试要断言返回值为 `True`。

`test_mark_run_succeeded_writes_terminal_event_and_clears_lease` 中：

```python
        changed = await mark_run_succeeded(
            session,
            run_id=run_id,
            usage={"prompt_tokens": 5},
            provider_request_id="req-1",
        )
        await session.commit()

    assert changed is True
```

`test_mark_run_failed_writes_terminal_event_and_records_error` 中：

```python
        changed = await mark_run_failed(
            session,
            run_id=run_id,
            code="upstream_5xx",
            message="bad upstream",
        )
        await session.commit()

    assert changed is True
```

`test_recover_expired_runs_marks_lease_expired_runs_failed` 不需要直接断言返回值，因为它通过 `recover_expired_runs()` 间接调用。

- [ ] **Step 5: 更新 executor 成功物化逻辑**

在 `app/worker/executor.py` 的 `Finish` 分支中，把 succeeded transition 结果保存下来；只有真正转成 `succeeded` 才物化 assistant message。

```python
                    changed = await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    if changed:
                        await materialize_assistant_message(
                            session,
                            run_id=run_id,
                            content=full_text,
                        )
                    await session.commit()
                if not changed:
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_delta_seen,
                        delta_persisted=first_delta_seen,
                    )
```

说明：这里返回 `cancelled` 是为了让外层走取消收尾；如果 run 实际已经是 `failed` 或 `cancelled`，Task 3 的 idempotent `mark_run_cancelled()` 会 no-op，不会追加第二个 terminal event。

- [ ] **Step 6: 更新 executor 取消/失败路径兼容 bool 返回值**

以下调用可以不使用返回值，但函数现在返回 `bool`：

```python
await mark_run_cancelled(session, run_id=run_id)
await mark_run_failed(
    session,
    run_id=run_id,
    code=outcome.code or "unknown_error",
    message=outcome.message or "",
)
```

不需要改变行为；mypy 不要求消费返回值。

- [ ] **Step 7: 运行 lifecycle 测试确认通过**

```bash
uv run pytest tests/services/runs/test_lifecycle.py -v
```

Expected: `tests/services/runs/test_lifecycle.py` 全部 PASS。

- [ ] **Step 8: 运行 worker executor 测试确认通过**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: `tests/worker/test_executor.py` 全部 PASS。

- [ ] **Step 9: 提交**

```bash
git add app/services/runs/lifecycle.py app/worker/executor.py tests/services/runs/test_lifecycle.py tests/worker/test_executor.py
git commit -m "fix: make run terminal transitions idempotent"
```

---

## Task 4: 最终验证

**Files:**
- No code changes.

- [ ] **Step 1: 运行 provider/worker 相关测试**

```bash
uv run pytest tests/providers tests/context tests/services/runs/test_lifecycle.py tests/services/conversations/test_materialize.py tests/worker -q
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行全量测试**

```bash
uv run pytest -q
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行 lint**

```bash
uv run ruff check .
```

Expected: `All checks passed!`

- [ ] **Step 4: 运行 type check**

```bash
uv run mypy .
```

Expected: `Success: no issues found`

- [ ] **Step 5: 验证 compose 配置**

```bash
docker compose -f compose.yml config
```

Expected: 命令成功退出，worker command 仍为 `python -m app.worker`。

---

## 自检

- Spec 覆盖：计划覆盖 review 中确认的三个 bug：DeepSeek thinking 配置、阻塞 stream 取消、terminal 状态竞态。
- 范围控制：不新增 provider/model 管理 API，不改 API 路由，不引入 Redis/Celery，不改变 conversation/message 业务语义。
- TDD 顺序：每个 bug 都先写失败测试，再写最小实现，最后局部和全量验证。
- 项目约束：文档使用中文；代码注释和用户可见错误信息不新增中文；默认当前分支开发，不创建 worktree。
