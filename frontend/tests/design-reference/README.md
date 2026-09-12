# Design 原版参考入口

此入口只用于测试，不属于生产构建入口。它使用正式前端的展示组件与 AppProvider，注入固定合成样本和本地结果；不访问生产 API。

由 `pnpm --dir design test:parity` 在独立端口 5183 启动。为隔离每个参考场景，会清空这个测试 origin 的 localStorage/sessionStorage；不要将此入口部署到生产域名。Design 自身启动与构建不依赖本目录。

类型检查：`pnpm --dir frontend exec tsc -p tsconfig.design-reference.json`。
