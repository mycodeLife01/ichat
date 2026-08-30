import pytest

from app.services.agents.registry import ProviderConnection
from app.services.model_catalog.credentials import (
    ModelCredentialCipher,
    ModelCredentialError,
    api_key_hint,
)


def test_credential_cipher_round_trips_without_embedding_plaintext() -> None:
    cipher = ModelCredentialCipher(ModelCredentialCipher.generate_key())

    ciphertext = cipher.encrypt("sk-sensitive-value")

    assert ciphertext.startswith("fernet:v1:")
    assert "sk-sensitive-value" not in ciphertext
    assert cipher.decrypt(ciphertext) == "sk-sensitive-value"


def test_credential_cipher_rejects_wrong_deployment_key_without_leaking_secret() -> None:
    ciphertext = ModelCredentialCipher(ModelCredentialCipher.generate_key()).encrypt(
        "sk-sensitive-value"
    )
    cipher = ModelCredentialCipher(ModelCredentialCipher.generate_key())

    with pytest.raises(ModelCredentialError) as exc_info:
        cipher.decrypt(ciphertext)

    assert "sk-sensitive-value" not in str(exc_info.value)


def test_api_key_hint_only_exposes_last_four_characters() -> None:
    assert api_key_hint("sk-example-1234") == "…1234"
    assert api_key_hint("tiny") == "configured"


def test_provider_connection_repr_does_not_expose_plaintext_api_key() -> None:
    connection = ProviderConnection(
        adapter="openrouter",
        api_key="sk-sensitive-value",
        base_url="https://openrouter.example/v1",
    )

    assert "sk-sensitive-value" not in repr(connection)
