from pathlib import Path


def test_compose_uses_explicit_env_file() -> None:
    compose = Path("compose.yml").read_text()

    assert compose.count("env_file:") == 3
    assert compose.count("- .env") == 3


def test_compose_requires_referenced_environment_variables() -> None:
    compose = Path("compose.yml").read_text()

    assert ":-" not in compose
    assert "${API_PORT:?API_PORT is required}" in compose
    assert "${POSTGRES_PORT:?POSTGRES_PORT is required}" in compose
    assert "DATABASE_URL:" not in compose
    assert "JWT_SECRET:" not in compose
    assert "DEEPSEEK_API_KEY:" not in compose
