from app.services.auth.passwords import hash_password, verify_password


def test_hash_password_does_not_store_plaintext() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert password_hash != "correct horse battery staple"
    assert verify_password("correct horse battery staple", password_hash) is True


def test_verify_password_rejects_wrong_password() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert verify_password("wrong password", password_hash) is False
