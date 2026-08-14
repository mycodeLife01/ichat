"""Cut over file model input kinds and isolate image previews.

The previous file-domain migration stored a boolean ``model_consumable`` and
placed every derivative in ``canonical_private``.  This migration is a short
maintenance-window cutover: it validates the existing rows, derives the
three-state representation, and only then removes the boolean column.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260803_0016"
down_revision: str | None = "20260801_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "files",
        sa.Column("model_input_kind", sa.String(length=16), nullable=True),
    )

    # Fail closed before mutating any existing fact.  A true legacy boolean
    # must have a complete document extract; image assets must never have been
    # marked consumable.  Any malformed derivative is treated as migration
    # input corruption instead of being silently downgraded.
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM files AS f
                    WHERE f.model_consumable
                      AND (
                          f.purpose <> 'message_attachment'
                          OR f.media_type LIKE 'image/%'
                          OR f.document_text IS NULL
                          OR btrim(f.document_text) = ''
                          OR NOT EXISTS (
                              SELECT 1
                              FROM file_objects AS o
                              WHERE o.file_id = f.id
                                AND o.role = 'document_extract'
                                AND o.storage_location = 'canonical_private'
                                AND o.size_bytes > 0
                                AND o.sha256 IS NOT NULL
                                AND length(o.sha256) = 64
                          )
                      )
                ) THEN
                    RAISE EXCEPTION
                        'Cannot cut over file model input kind: invalid legacy document asset';
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM files AS f
                    JOIN file_objects AS o ON o.file_id = f.id
                    WHERE o.role = 'preview'
                      AND (
                          f.purpose <> 'message_attachment'
                          OR f.media_type NOT LIKE 'image/%'
                          OR f.extractor_version IS DISTINCT FROM 'image-v1'
                          OR o.storage_location <> 'canonical_private'
                          OR o.size_bytes <= 0
                          OR o.sha256 IS NULL
                          OR length(o.sha256) <> 64
                          OR o.media_type <> 'image/webp'
                          OR NOT COALESCE(f.summary_metadata ? 'width', false)
                          OR NOT COALESCE(f.summary_metadata ? 'height', false)
                          OR NOT COALESCE(
                              (f.summary_metadata->>'width') ~ '^[1-9][0-9]*$', false
                          )
                          OR NOT COALESCE(
                              (f.summary_metadata->>'height') ~ '^[1-9][0-9]*$', false
                          )
                      )
                ) THEN
                    RAISE EXCEPTION
                        'Cannot cut over file model input kind: invalid image preview asset';
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM files AS f
                    JOIN file_objects AS o ON o.file_id = f.id
                    WHERE o.role = 'document_extract'
                      AND (
                          f.purpose <> 'message_attachment'
                          OR f.media_type LIKE 'image/%'
                          OR f.model_consumable IS FALSE
                          OR f.document_text IS NULL
                          OR btrim(f.document_text) = ''
                          OR o.storage_location <> 'canonical_private'
                          OR o.size_bytes <= 0
                          OR o.sha256 IS NULL
                          OR length(o.sha256) <> 64
                      )
                ) THEN
                    RAISE EXCEPTION
                        'Cannot cut over file model input kind: inconsistent '
                        'document extract asset';
                END IF;
            END $$;
            """
        )
    )

    op.execute(
        sa.text(
            """
            UPDATE files AS f
            SET model_input_kind = CASE
                WHEN f.purpose = 'message_attachment'
                 AND f.media_type LIKE 'image/%'
                 AND EXISTS (
                     SELECT 1
                     FROM file_objects AS o
                     WHERE o.file_id = f.id
                       AND o.role = 'preview'
                       AND o.storage_location = 'canonical_private'
                       AND o.size_bytes > 0
                       AND o.sha256 IS NOT NULL
                       AND length(o.sha256) = 64
                       AND o.media_type = 'image/webp'
                       AND f.extractor_version = 'image-v1'
                       AND f.summary_metadata ? 'width'
                       AND f.summary_metadata ? 'height'
                       AND (f.summary_metadata->>'width') ~ '^[1-9][0-9]*$'
                       AND (f.summary_metadata->>'height') ~ '^[1-9][0-9]*$'
                 ) THEN 'image'
                WHEN f.purpose = 'message_attachment'
                 AND f.model_consumable
                 AND f.document_text IS NOT NULL
                 AND btrim(f.document_text) <> ''
                 AND EXISTS (
                     SELECT 1
                     FROM file_objects AS o
                     WHERE o.file_id = f.id
                       AND o.role = 'document_extract'
                       AND o.storage_location = 'canonical_private'
                       AND o.size_bytes > 0
                       AND o.sha256 IS NOT NULL
                       AND length(o.sha256) = 64
                 ) THEN 'document'
                ELSE NULL
            END
            """
        )
    )
    op.create_check_constraint(
        "ck_files_model_input_kind_valid",
        "files",
        "model_input_kind IN ('document', 'image')",
    )
    op.drop_column("files", "model_consumable")

    op.drop_constraint("ck_file_objects_storage_location_valid", "file_objects", type_="check")
    op.create_check_constraint(
        "ck_file_objects_storage_location_valid",
        "file_objects",
        "storage_location IN ('canonical_private', 'model_preview_private', 'avatar_public')",
    )
    op.drop_constraint(
        "ck_file_object_deletions_storage_location_valid",
        "file_object_deletions",
        type_="check",
    )
    op.create_check_constraint(
        "ck_file_object_deletions_storage_location_valid",
        "file_object_deletions",
        "storage_location IN ('canonical_private', 'model_preview_private', 'avatar_public')",
    )


def downgrade() -> None:
    bind = op.get_bind()
    has_preview_rows = bind.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM file_objects "
            "WHERE storage_location = 'model_preview_private')"
        )
    ).scalar()
    if has_preview_rows:
        raise RuntimeError(
            "Refusing to downgrade while model preview objects still exist; "
            "drain the preview bucket and migrate rows first."
        )

    op.drop_constraint("ck_file_objects_storage_location_valid", "file_objects", type_="check")
    op.create_check_constraint(
        "ck_file_objects_storage_location_valid",
        "file_objects",
        "storage_location IN ('canonical_private', 'avatar_public')",
    )
    op.drop_constraint(
        "ck_file_object_deletions_storage_location_valid",
        "file_object_deletions",
        type_="check",
    )
    op.create_check_constraint(
        "ck_file_object_deletions_storage_location_valid",
        "file_object_deletions",
        "storage_location IN ('canonical_private', 'avatar_public')",
    )

    op.add_column(
        "files",
        sa.Column("model_consumable", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        sa.text(
            "UPDATE files SET model_consumable = (model_input_kind = 'document')"
        )
    )
    op.drop_constraint("ck_files_model_input_kind_valid", "files", type_="check")
    op.drop_column("files", "model_input_kind")
