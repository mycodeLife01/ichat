"""Boundary guard: the agent kernel (``app/agent``) must stay free of application
config, the database/ORM, and the services layer. Enforced statically so a stray
import fails fast rather than silently re-coupling the kernel."""

import ast
import pathlib

_AGENT_DIR = pathlib.Path(__file__).resolve().parents[2] / "app" / "agent"
_FORBIDDEN_PREFIXES = ("app.core.config", "app.services", "app.models", "app.db")


def _imported_modules(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            modules.add(node.module)
    return modules


def test_kernel_imports_no_config_db_or_services() -> None:
    offenders: dict[str, list[str]] = {}
    for path in sorted(_AGENT_DIR.rglob("*.py")):
        forbidden = sorted(
            module
            for module in _imported_modules(path)
            if any(module == p or module.startswith(p + ".") for p in _FORBIDDEN_PREFIXES)
        )
        if forbidden:
            offenders[str(path.relative_to(_AGENT_DIR))] = forbidden
    assert not offenders, f"kernel modules import forbidden dependencies: {offenders}"
