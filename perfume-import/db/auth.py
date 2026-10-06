"""Team login: users created by an admin, scrypt password hashes, sessions as random tokens whose SHA-256 is
stored (a copy of the database cannot be used to log in). The first admin is created on an empty database."""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from db.models import User, UserSession

SESSION_DAYS = 30
MIN_PASSWORD = 10
_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


class AuthError(Exception):
    """Bulgarian message for the person."""


def _engine():
    from db.repo import engine

    return engine()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), **_SCRYPT)
    return hmac.compare_digest(candidate.hex(), digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _public(u: User) -> dict:
    return {"id": u.id, "name": u.name, "is_admin": u.is_admin, "disabled": u.disabled}


def _valid(name: str, password: str) -> str:
    name = name.strip()
    if not name:
        raise AuthError("Въведи име.")
    if len(password) < MIN_PASSWORD:
        raise AuthError(f"Паролата трябва да е поне {MIN_PASSWORD} знака.")
    return name


def setup_needed() -> bool:
    with Session(_engine()) as session:
        return not session.scalar(select(func.count()).select_from(User))


def create_user(name: str, password: str, is_admin: bool = False, *, first: bool = False) -> dict:
    """first=True: the first admin, allowed only while there is no user at all."""
    name = _valid(name, password)
    with Session(_engine()) as session, session.begin():
        if first:
            session.execute(select(func.pg_advisory_xact_lock(7401)))  # two first admins at once: one wins
            if session.scalar(select(func.count()).select_from(User)):
                raise AuthError("Вече има потребители: влез с името и паролата си.")
            is_admin = True
        if session.scalar(select(User).where(func.lower(User.name) == name.lower())):
            raise AuthError(f"Вече има потребител „{name}“.")
        user = User(name=name, password_hash=hash_password(password), is_admin=is_admin)
        session.add(user)
        session.flush()
        return _public(user)


def login(name: str, password: str) -> tuple[str, dict]:
    """(session token for the cookie, user)."""
    with Session(_engine()) as session, session.begin():
        user = session.scalar(select(User).where(func.lower(User.name) == name.strip().lower()))
        if user is None or user.disabled or not check_password(password, user.password_hash):
            raise AuthError("Грешно име или парола.")
        token = secrets.token_urlsafe(32)
        session.add(
            UserSession(
                token_hash=_token_hash(token),
                user_id=user.id,
                expires_at=datetime.now(UTC) + timedelta(days=SESSION_DAYS),
            )
        )
        session.execute(delete(UserSession).where(UserSession.expires_at < datetime.now(UTC)))
        return token, _public(user)


def user_for(token: str | None) -> dict | None:
    if not token:
        return None
    with Session(_engine()) as session:
        row = session.execute(
            select(User)
            .join(UserSession, UserSession.user_id == User.id)
            .where(UserSession.token_hash == _token_hash(token), UserSession.expires_at > datetime.now(UTC))
        ).scalar_one_or_none()
        return _public(row) if row and not row.disabled else None


def logout(token: str | None) -> None:
    if token:
        with Session(_engine()) as session, session.begin():
            session.execute(delete(UserSession).where(UserSession.token_hash == _token_hash(token)))


def list_users() -> list[dict]:
    with Session(_engine()) as session:
        return [_public(u) for u in session.scalars(select(User).order_by(User.name))]


def update_user(
    user_id: int, actor_id: int, password: str | None = None, is_admin: bool | None = None, disabled: bool | None = None
) -> dict:
    with Session(_engine()) as session, session.begin():
        user = session.get(User, user_id)
        if user is None:
            raise KeyError("Няма такъв потребител.")
        if user_id == actor_id and (is_admin is False or disabled):
            raise AuthError("Не можеш да спреш себе си или да си махнеш правата на администратор.")
        if password is not None:
            _valid(user.name, password)
            user.password_hash = hash_password(password)
            session.execute(delete(UserSession).where(UserSession.user_id == user.id))  # logged out everywhere
        if is_admin is not None:
            user.is_admin = is_admin
        if disabled is not None:
            user.disabled = disabled
            if disabled:
                session.execute(delete(UserSession).where(UserSession.user_id == user.id))
        return _public(user)


def change_password(user_id: int, current: str, new: str) -> dict:
    with Session(_engine()) as session:
        user = session.get(User, user_id)
        if user is None or not check_password(current, user.password_hash):
            raise AuthError("Сегашната парола не е вярна.")
    return update_user(user_id, user_id, password=new)
