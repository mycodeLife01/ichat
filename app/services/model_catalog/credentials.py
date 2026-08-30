from cryptography.fernet import Fernet, InvalidToken

_CIPHERTEXT_PREFIX = "fernet:v1:"


class ModelCredentialError(Exception):
    """Stable, secret-free model credential configuration failure."""


class ModelCredentialCipher:
    def __init__(self, key: str) -> None:
        normalized = key.strip()
        if not normalized:
            raise ModelCredentialError("Model catalog encryption key is not configured")
        try:
            self._fernet = Fernet(normalized.encode("ascii"))
        except (UnicodeEncodeError, ValueError) as exc:
            raise ModelCredentialError("Model catalog encryption key is invalid") from exc

    @staticmethod
    def generate_key() -> str:
        return Fernet.generate_key().decode("ascii")

    def encrypt(self, api_key: str) -> str:
        secret = api_key.strip()
        if not secret:
            raise ModelCredentialError("Model upstream API key must not be empty")
        token = self._fernet.encrypt(secret.encode("utf-8")).decode("ascii")
        return f"{_CIPHERTEXT_PREFIX}{token}"

    def decrypt(self, ciphertext: str) -> str:
        if not ciphertext.startswith(_CIPHERTEXT_PREFIX):
            raise ModelCredentialError("Model upstream credential format is unsupported")
        token = ciphertext.removeprefix(_CIPHERTEXT_PREFIX)
        try:
            plaintext = self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, UnicodeEncodeError) as exc:
            raise ModelCredentialError("Model upstream credential could not be decrypted") from exc
        if not plaintext:
            raise ModelCredentialError("Model upstream credential is empty")
        return plaintext


def api_key_hint(api_key: str) -> str:
    secret = api_key.strip()
    if len(secret) <= 4:
        return "configured"
    return f"…{secret[-4:]}"
