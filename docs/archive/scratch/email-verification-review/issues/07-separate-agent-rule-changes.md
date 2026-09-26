# 从邮箱认证变更集中拆出无关代理规则改动

Type: task

Status: completed

Blocked by: None

## What to build

邮箱认证变更集只包含该功能、修复工作和已批准的本地 tracker 配置；与功能无关的通用代理模型及开发规则调整独立记录，不干扰功能审查。

## Acceptance criteria

- [x] 与邮箱认证无关的通用代理模型策略和开发规则不再出现在功能变更集中。
- [x] 本次已批准的本地 tracker、triage 标签和 single-context 配置继续保留。
- [x] 拆分过程不丢失用户已有的其他工作区改动，也不改写无关提交内容。
- [x] 最终差异可以清晰区分邮箱认证功能、审查修复和工程技能配置。

## Comments

2026-07-11：通过新增修复恢复审查基线规则，未改写历史提交；保留 tracker 配置与邮箱架构说明。
