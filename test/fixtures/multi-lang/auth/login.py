def login_user(email: str, password: str) -> bool:
    return len(email) > 0 and len(password) > 0

class SessionStore:
    pass
