from pathlib import Path

DEPLOY_WORKFLOW = Path(".github/workflows/deploy.yml")
CI_WORKFLOW = Path(".github/workflows/ci.yml")


def test_deployment_definitions_are_uploaded_before_compose_commands() -> None:
    workflow = DEPLOY_WORKFLOW.read_text()

    checkout_position = workflow.index("uses: actions/checkout@v4", workflow.index("deploy:"))
    upload_position = workflow.index("uses: appleboy/scp-action@", checkout_position)
    compose_position = workflow.index("docker compose -f compose.prod.yml", upload_position)

    assert checkout_position < upload_position < compose_position
    assert "compose.prod.yml" in workflow[upload_position:compose_position]
    assert "deploy/nginx.conf" in workflow[upload_position:compose_position]


def test_remote_deployment_is_fail_fast_and_updates_the_complete_topology() -> None:
    workflow = DEPLOY_WORKFLOW.read_text()
    compose = Path("compose.prod.yml").read_text()

    assert "group: production-deploy" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "set -eu" in workflow
    assert "docker compose -f compose.prod.yml --profile migrate pull" in workflow
    assert "docker compose -f compose.prod.yml run --rm migrate" in workflow
    assert "docker compose -f compose.prod.yml up -d --remove-orphans" in workflow
    assert (
        "docker compose -f compose.prod.yml up -d --no-deps --force-recreate nginx" in workflow
    )

    for service in (
        "redis",
        "api",
        "worker",
        "celery-worker",
        "celery-beat",
        "nginx",
    ):
        assert f"  {service}:" in compose

    assert "./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro" in compose


def test_ci_validates_the_production_compose_configuration() -> None:
    workflow = CI_WORKFLOW.read_text()

    assert "docker compose -f compose.prod.yml config --quiet" in workflow
