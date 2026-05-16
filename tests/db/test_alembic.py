from pathlib import Path


def test_alembic_runtime_files_exist() -> None:
    assert Path("alembic.ini").is_file()
    assert Path("alembic/env.py").is_file()
    assert Path("alembic/versions").is_dir()


def test_core_schema_migration_exists() -> None:
    migrations = [
        path
        for path in Path("alembic/versions").glob("*.py")
        if path.name != "__init__.py"
    ]

    assert len(migrations) == 1
