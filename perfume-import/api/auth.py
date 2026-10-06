"""Login for the team. Every /api route except health and these needs a session cookie (require_user)."""

import time
from collections import defaultdict, deque
from contextvars import ContextVar
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from db import auth

COOKIE = "perfume_session"
current_user: ContextVar[dict | None] = ContextVar("current_user", default=None)
router = APIRouter(prefix="/api/auth")

# Failed logins per name and per address: 5 in 15 minutes, then wait.
_failures: dict[str, deque] = defaultdict(deque)
WINDOW, MAX_FAILURES = 15 * 60, 5


def _limited(*keys: str) -> bool:
    now = time.monotonic()
    for key in keys:
        q = _failures[key]
        while q and now - q[0] > WINDOW:
            q.popleft()
        if len(q) >= MAX_FAILURES:
            return True
    return False


def _failed(*keys: str) -> None:
    for key in keys:
        _failures[key].append(time.monotonic())


async def require_user(request: Request) -> dict:
    """Async on purpose: the context variable it sets is then seen by the (threaded) endpoint."""
    user = auth.user_for(request.cookies.get(COOKIE))
    if user is None:
        raise HTTPException(401, "Влез в приложението.")
    current_user.set(user)
    return user


async def require_admin(user: Annotated[dict, Depends(require_user)]) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "Само администратор може да прави това.")
    return user


def _set_cookie(request: Request, response: Response, token: str) -> None:
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(
        COOKIE, token, max_age=auth.SESSION_DAYS * 86400, httponly=True, secure=https, samesite="lax", path="/"
    )


class Credentials(BaseModel):
    name: str
    password: str


class NewUser(Credentials):
    is_admin: bool = False


class UserChange(BaseModel):
    password: str | None = None
    is_admin: bool | None = None
    disabled: bool | None = None


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except auth.AuthError as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc


@router.get("/me")
def me(request: Request):
    """The logged-in user, or who has to do what first (setup or login)."""
    user = auth.user_for(request.cookies.get(COOKIE))
    return {"user": user, "setup_needed": user is None and auth.setup_needed()}


@router.post("/setup")
def setup(body: Credentials, request: Request, response: Response):
    """The first admin, on an empty database only."""
    user = _call(auth.create_user, body.name, body.password, first=True)
    token, _ = auth.login(body.name, body.password)
    _set_cookie(request, response, token)
    return {"user": user}


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    keys = (f"name:{body.name.strip().lower()}", f"ip:{request.client.host if request.client else '-'}")
    if _limited(*keys):
        raise HTTPException(429, "Твърде много грешни опити. Опитай след 15 минути.")
    try:
        token, user = auth.login(body.name, body.password)
    except auth.AuthError as exc:
        _failed(*keys)
        raise HTTPException(401, str(exc)) from exc
    _set_cookie(request, response, token)
    return {"user": user}


@router.post("/logout")
def logout(request: Request, response: Response):
    auth.logout(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/users", dependencies=[Depends(require_admin)])
def users():
    return auth.list_users()


@router.post("/users", status_code=201, dependencies=[Depends(require_admin)])
def create_user(body: NewUser):
    return _call(auth.create_user, body.name, body.password, body.is_admin)


@router.patch("/users/{user_id}")
def change_user(user_id: int, body: UserChange, admin: Annotated[dict, Depends(require_admin)]):
    return _call(auth.update_user, user_id, admin["id"], body.password, body.is_admin, body.disabled)


class PasswordChange(BaseModel):
    current: str
    new: str


@router.post("/password")
def change_own_password(body: PasswordChange, user: Annotated[dict, Depends(require_user)]):
    return _call(auth.change_password, user["id"], body.current, body.new)
