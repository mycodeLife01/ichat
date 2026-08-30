"""Local operator CLI for the database-backed model catalog."""

import argparse
import asyncio
import getpass
import sys
from collections.abc import Sequence

from app.core.config import get_settings
from app.db.session import get_session_factory
from app.services.model_catalog.credentials import (
    ModelCredentialCipher,
    ModelCredentialError,
)
from app.services.model_catalog.management import (
    CatalogInventory,
    catalog_inventory,
    import_environment_catalog,
    set_chat_model_enabled,
    set_database_catalog_enabled,
    set_model_route_enabled,
    set_model_upstream_enabled,
    upsert_chat_model,
    upsert_model_route,
    upsert_model_upstream,
)
from app.services.model_catalog.service import ModelCatalogError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.model_admin")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("generate-key", help="Generate a deployment encryption key")
    commands.add_parser("status", help="List catalog state, models, upstreams, and routes")

    import_env = commands.add_parser("import-env", help="Import the legacy ENV catalog")
    import_env.add_argument("--activate", action="store_true")
    commands.add_parser("activate", help="Use the database catalog for new requests")
    commands.add_parser("deactivate", help="Fall back to the legacy ENV catalog")

    model = commands.add_parser("upsert-model", help="Create or replace model metadata")
    model.add_argument("--key", required=True)
    model.add_argument("--label", required=True)
    model.add_argument("--thinking-levels", default="")
    model.add_argument("--vision", action="store_true")
    model.add_argument("--image-token-reserve", type=int)
    model.add_argument(
        "--token-profile",
        choices=("default", "deepseek", "openai"),
        default="default",
    )
    model.add_argument("--sort-order", type=int, default=100)
    _enabled_flags(model)

    upstream = commands.add_parser(
        "upsert-upstream",
        help="Create or replace an upstream endpoint; omit key input to preserve it",
    )
    upstream.add_argument("--key", required=True)
    upstream.add_argument("--label", required=True)
    upstream.add_argument("--adapter", choices=("deepseek", "openai", "openrouter"), required=True)
    upstream.add_argument("--base-url", required=True)
    api_key_source = upstream.add_mutually_exclusive_group()
    api_key_source.add_argument(
        "--set-api-key",
        action="store_true",
        help="Prompt without echo for a new API key",
    )
    api_key_source.add_argument(
        "--api-key-stdin",
        action="store_true",
        help="Read one API key line from stdin",
    )
    _enabled_flags(upstream)

    route = commands.add_parser("upsert-route", help="Create or update a model route")
    _route_identity_args(route)
    route.add_argument("--priority", type=int, default=100)
    route.add_argument(
        "--reasoning-outputs",
        help="Comma-separated visible outputs: raw,summary",
    )
    _enabled_flags(route)

    set_model = commands.add_parser("set-model", help="Enable or disable a model")
    set_model.add_argument("--key", required=True)
    _required_enabled_flags(set_model)

    set_upstream = commands.add_parser("set-upstream", help="Enable or disable an upstream")
    set_upstream.add_argument("--key", required=True)
    _required_enabled_flags(set_upstream)

    set_route = commands.add_parser("set-route", help="Enable or disable a route")
    _route_identity_args(set_route)
    _required_enabled_flags(set_route)
    return parser


def _enabled_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--enabled", action="store_const", const=True, dest="enabled")
    group.add_argument("--disabled", action="store_const", const=False, dest="enabled")
    parser.set_defaults(enabled=None)


def _required_enabled_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--enabled", action="store_true", dest="enabled")
    group.add_argument("--disabled", action="store_false", dest="enabled")


def _route_identity_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", required=True)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--upstream-model", required=True)


async def _run(args: argparse.Namespace) -> None:
    settings = get_settings()
    factory = get_session_factory()
    async with factory() as session:
        if args.command == "status":
            _print_inventory(await catalog_inventory(session))
            return
        if args.command == "import-env":
            await import_environment_catalog(session, settings=settings)
            if args.activate:
                await set_database_catalog_enabled(session, enabled=True, settings=settings)
        elif args.command == "activate":
            await set_database_catalog_enabled(session, enabled=True, settings=settings)
        elif args.command == "deactivate":
            await set_database_catalog_enabled(session, enabled=False, settings=settings)
        elif args.command == "upsert-model":
            await upsert_chat_model(
                session,
                key=args.key,
                label=args.label,
                thinking_levels=_comma_list(args.thinking_levels),
                supports_image_input=args.vision,
                image_token_reserve=args.image_token_reserve,
                token_profile=args.token_profile,
                sort_order=args.sort_order,
                enabled=args.enabled,
                settings=settings,
            )
        elif args.command == "upsert-upstream":
            await upsert_model_upstream(
                session,
                key=args.key,
                label=args.label,
                adapter=args.adapter,
                base_url=args.base_url,
                api_key=_read_api_key(args),
                settings=settings,
                enabled=args.enabled,
            )
        elif args.command == "upsert-route":
            await upsert_model_route(
                session,
                model_key=args.model,
                upstream_key=args.upstream,
                upstream_model=args.upstream_model,
                priority=args.priority,
                reasoning_outputs=(
                    _comma_list(args.reasoning_outputs)
                    if args.reasoning_outputs is not None
                    else None
                ),
                enabled=args.enabled,
            )
        elif args.command == "set-model":
            await set_chat_model_enabled(session, key=args.key, enabled=args.enabled)
        elif args.command == "set-upstream":
            await set_model_upstream_enabled(session, key=args.key, enabled=args.enabled)
        elif args.command == "set-route":
            await set_model_route_enabled(
                session,
                model_key=args.model,
                upstream_key=args.upstream,
                upstream_model=args.upstream_model,
                enabled=args.enabled,
            )
        else:  # pragma: no cover - argparse owns the command set.
            raise AssertionError(f"Unsupported command: {args.command}")
        await session.commit()
    print("ok")


def _read_api_key(args: argparse.Namespace) -> str | None:
    if args.set_api_key:
        return getpass.getpass("Model upstream API key: ")
    if args.api_key_stdin:
        return sys.stdin.readline().rstrip("\r\n")
    return None


def _comma_list(raw: str) -> list[str]:
    if not raw.strip():
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _print_inventory(inventory: CatalogInventory) -> None:
    models = inventory.models
    upstreams = inventory.upstreams
    routes = inventory.routes
    print(f"catalog\t{'database' if inventory.database_enabled else 'environment'}")
    print("models")
    for model in models:
        levels = ",".join(model.thinking_levels)
        print(
            f"{model.key}\t{'on' if model.enabled else 'off'}\t{model.sort_order}"
            f"\t{model.label}\t{model.token_profile}\t{levels or '-'}"
            f"\t{'vision' if model.supports_image_input else 'text'}"
        )
    print("upstreams")
    for upstream in upstreams:
        print(
            f"{upstream.key}\t{'on' if upstream.enabled else 'off'}\t{upstream.adapter}"
            f"\t{upstream.base_url}\t{upstream.api_key_hint}\t{upstream.label}"
        )
    model_keys = {model.id: model.key for model in models}
    upstream_keys = {upstream.id: upstream.key for upstream in upstreams}
    print("routes")
    for route in routes:
        print(
            f"{model_keys.get(route.chat_model_id, route.chat_model_id)}"
            f"\t{upstream_keys.get(route.upstream_id, route.upstream_id)}"
            f"\t{route.upstream_model}\t{'on' if route.enabled else 'off'}"
            f"\t{route.priority}\t{','.join(route.reasoning_outputs) or '-'}"
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "generate-key":
        print(ModelCredentialCipher.generate_key())
        return 0
    try:
        asyncio.run(_run(args))
    except (ModelCatalogError, ModelCredentialError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
