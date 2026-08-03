from pathlib import Path


def test_alembic_runtime_files_exist() -> None:
    assert Path("alembic.ini").is_file()
    assert Path("alembic/env.py").is_file()
    assert Path("alembic/versions").is_dir()


def test_core_schema_migrations_exist() -> None:
    migrations = [
        path
        for path in Path("alembic/versions").glob("*.py")
        if path.name != "__init__.py"
    ]

    assert len(migrations) >= 2
    assert Path(
        "alembic/versions/20260519_0002_add_conversation_activation.py"
    ).is_file()


def test_file_domain_migration_is_additive_and_keeps_legacy_avatar_fallback() -> None:
    migration = Path("alembic/versions/20260801_0015_add_file_domain.py")
    assert migration.is_file()
    source = migration.read_text()
    upgrade_source, downgrade_source = source.split("def downgrade() -> None:", maxsplit=1)

    assert 'revision: str = "20260801_0015"' in source
    assert 'down_revision: str | None = "20260720_0014"' in source
    assert "avatar_file_id" in upgrade_source
    assert "avatar_object_key" in upgrade_source
    assert "legacy_import" in upgrade_source
    assert "op.drop_" not in upgrade_source
    assert "Refusing to downgrade unified files" in downgrade_source


def test_vision_file_contract_migration_is_a_fail_closed_cutover() -> None:
    migration = Path("alembic/versions/20260803_0016_vision_file_contract.py")
    assert migration.is_file()
    source = migration.read_text()
    upgrade_source, downgrade_source = source.split("def downgrade() -> None:", maxsplit=1)

    assert 'revision: str = "20260803_0016"' in source
    assert 'down_revision: str | None = "20260801_0015"' in source
    assert 'sa.Column("model_input_kind"' in upgrade_source
    assert "invalid legacy document asset" in upgrade_source
    assert "invalid image preview asset" in upgrade_source
    assert "THEN 'image'" in upgrade_source
    assert "THEN 'document'" in upgrade_source
    assert upgrade_source.index('sa.Column("model_input_kind"') < upgrade_source.index(
        'op.drop_column("files", "model_consumable")'
    )
    assert "model_preview_private" in upgrade_source
    assert "Refusing to downgrade while model preview objects still exist" in downgrade_source
