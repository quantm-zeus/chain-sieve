from __future__ import annotations

import base64
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


@dataclass(frozen=True)
class InstallationToken:
    value: str
    expires_at: float


class GitHubAppTokenSource:
    """Mint and cache one GitHub App installation token in process memory only."""

    def __init__(
        self,
        app_id: str,
        installation_id: str,
        private_key_path: Path,
        *,
        mint: Callable[[], InstallationToken] | None = None,
        clock: Callable[[], float] = time.time,
        refresh_skew_seconds: int = 300,
    ) -> None:
        if not app_id or not installation_id or not str(private_key_path):
            raise ValueError("GitHub App ID, installation ID, and private-key path are required")
        self.app_id = app_id
        self.installation_id = installation_id
        self.private_key_path = private_key_path
        self._mint_override = mint
        self._clock = clock
        self._refresh_skew_seconds = refresh_skew_seconds
        self._cached: InstallationToken | None = None
        self._actor: str | None = None

    @classmethod
    def from_environment(cls) -> "GitHubAppTokenSource | None":
        app_id = os.environ.get("CHAINSIEVE_GITHUB_APP_ID", "").strip()
        installation_id = os.environ.get("CHAINSIEVE_GITHUB_INSTALLATION_ID", "").strip()
        key_path = os.environ.get("CHAINSIEVE_GITHUB_PRIVATE_KEY_PATH", "").strip()
        present = (bool(app_id), bool(installation_id), bool(key_path))
        if not any(present):
            return None
        if not all(present):
            raise RuntimeError("GitHub App credential configuration is incomplete")
        return cls(app_id, installation_id, Path(key_path))

    def token(self) -> str:
        now = self._clock()
        if self._cached and now < self._cached.expires_at - self._refresh_skew_seconds:
            return self._cached.value
        token = self._mint_override() if self._mint_override else self._mint()
        if not token.value or token.expires_at <= now:
            raise RuntimeError("GitHub App token mint returned an empty or expired token")
        self._cached = token
        return token.value

    def invalidate(self) -> None:
        self._cached = None

    def app_actor(self) -> str:
        if self._actor:
            return self._actor
        request = urllib.request.Request(
            "https://api.github.com/app",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._jwt()}",
                "User-Agent": "chainsieve-factory-token-source",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            raise RuntimeError("unable to inspect GitHub App identity") from error
        slug = str(payload.get("slug", "")).strip()
        if not slug:
            raise RuntimeError("GitHub App identity response has no slug")
        self._actor = f"{slug}[bot]"
        return self._actor

    def _jwt(self) -> str:
        now = int(self._clock())
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        claims = _b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": self.app_id}, separators=(",", ":")).encode())
        signing_input = f"{header}.{claims}".encode("ascii")
        try:
            signature = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", str(self.private_key_path)],
                input=signing_input,
                capture_output=True,
                check=True,
                timeout=15,
            ).stdout
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError("unable to sign GitHub App JWT") from error
        return f"{header}.{claims}.{_b64url(signature)}"

    def _mint(self) -> InstallationToken:
        request = urllib.request.Request(
            f"https://api.github.com/app/installations/{self.installation_id}/access_tokens",
            method="POST",
            data=b"{}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._jwt()}",
                "User-Agent": "chainsieve-factory-token-source",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            raise RuntimeError("unable to mint GitHub App installation token") from error
        expires_at = _parse_github_time(str(payload.get("expires_at", "")))
        return InstallationToken(str(payload.get("token", "")), expires_at)


def _parse_github_time(value: str) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError as error:
        raise RuntimeError("GitHub token response has an invalid expiration") from error
