"""
Cloud-backed storage (S3-compatible): same semantics as file backend, keys under prefix.

Uses boto3; set AGENT_STORAGE_BACKEND=cloud and configure bucket + credentials.
Optional dependency: pip install boto3
"""

import json
from typing import Any, Dict, List, Optional

from storage.protocols import StorageBackend

# Prefix for all keys to avoid collisions
KEY_PREFIX = "agent"
SESSIONS_PREFIX = f"{KEY_PREFIX}/sessions/"
MEMORY_KEY = f"{KEY_PREFIX}/memory/data"
SKILLS_PREFIX = f"{KEY_PREFIX}/skills/"
CONTEXT_PREFIX = f"{KEY_PREFIX}/context/"


def _get_client():
    """Lazy boto3 client; raises if boto3 not installed or config invalid."""
    try:
        import boto3
        from botocore.config import Config
    except ImportError as e:
        raise RuntimeError(
            "Cloud storage requires boto3. Install with: pip install boto3"
        ) from e
    bucket = _config_bucket()
    endpoint = _config_endpoint()
    region = _config_region()
    cfg = Config(signature_version="s3v4")
    if endpoint:
        return boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region or "us-east-1",
            config=cfg,
        ), bucket
    return boto3.client("s3", region_name=region or "us-east-1", config=cfg), bucket


def _config_bucket() -> str:
    import os
    v = os.environ.get("AGENT_STORAGE_BUCKET", "").strip()
    if not v:
        raise ValueError("Cloud storage requires AGENT_STORAGE_BUCKET")
    return v


def _config_endpoint() -> Optional[str]:
    import os
    return os.environ.get("AGENT_S3_ENDPOINT", "").strip() or None


def _config_region() -> str:
    import os
    return os.environ.get("AGENT_STORAGE_REGION", os.environ.get("AWS_REGION", "us-east-1")).strip()


def _encode(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def _decode(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"))


class CloudSessionStore:
    def __init__(self, client=None, bucket: Optional[str] = None) -> None:
        if client is not None and bucket is not None:
            self._client = client
            self._bucket = bucket
        else:
            self._client, self._bucket = _get_client()

    def _key(self, session_id: str) -> str:
        return f"{SESSIONS_PREFIX}{session_id}"

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        try:
            r = self._client.get_object(Bucket=self._bucket, Key=self._key(session_id))
            return _decode(r["Body"].read())
        except Exception:
            return None

    def put(self, session_id: str, data: Dict[str, Any]) -> None:
        self._client.put_object(
            Bucket=self._bucket,
            Key=self._key(session_id),
            Body=_encode(data),
            ContentType="application/json; charset=utf-8",
        )

    def list_ids(self) -> List[str]:
        ids: List[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=SESSIONS_PREFIX):
            for obj in page.get("Contents") or []:
                k = obj["Key"]
                if k.endswith("/"):
                    continue
                sid = k[len(SESSIONS_PREFIX):]
                if sid:
                    ids.append(sid)
        return sorted(ids)

    def list_summaries(self, limit: int = 20) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=SESSIONS_PREFIX):
            for obj in page.get("Contents") or []:
                k = obj["Key"]
                if k.endswith("/"):
                    continue
                sid = k[len(SESSIONS_PREFIX):]
                if not sid:
                    continue
                data = self.get(sid)
                if not data:
                    continue
                entries.append({
                    "id": sid,
                    "updated_at": data.get("updated_at", 0),
                    "turns": len([m for m in data.get("history", []) if m.get("role") == "user"]),
                    "state": data.get("state", "active"),
                })
        entries.sort(key=lambda e: e["updated_at"], reverse=True)
        return entries[:limit]


class CloudMemoryStore:
    def __init__(self, client=None, bucket: Optional[str] = None) -> None:
        if client is not None and bucket is not None:
            self._client = client
            self._bucket = bucket
        else:
            self._client, self._bucket = _get_client()

    def load(self) -> List[Dict[str, Any]]:
        try:
            r = self._client.get_object(Bucket=self._bucket, Key=MEMORY_KEY)
            data = _decode(r["Body"].read())
            return list(data) if isinstance(data, list) else []
        except Exception:
            return []

    def save(self, items: List[Dict[str, Any]]) -> None:
        self._client.put_object(
            Bucket=self._bucket,
            Key=MEMORY_KEY,
            Body=_encode(items),
            ContentType="application/json; charset=utf-8",
        )


class CloudSkillStore:
    """Skills stored as JSON objects: {name, description, body} per key."""

    def __init__(self, client=None, bucket: Optional[str] = None) -> None:
        if client is not None and bucket is not None:
            self._client = client
            self._bucket = bucket
        else:
            self._client, self._bucket = _get_client()

    def list_skills(self) -> List[str]:
        names: List[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=SKILLS_PREFIX):
            for obj in page.get("Contents") or []:
                k = obj["Key"]
                if k.endswith("/"):
                    continue
                name = k[len(SKILLS_PREFIX):]
                if name:
                    names.append(name)
        return sorted(names)

    def get_skill(self, name: str) -> Optional[Dict[str, Any]]:
        key = f"{SKILLS_PREFIX}{name}"
        try:
            r = self._client.get_object(Bucket=self._bucket, Key=key)
            return _decode(r["Body"].read())
        except Exception:
            return None


class CloudContextStore:
    def __init__(self, client=None, bucket: Optional[str] = None) -> None:
        if client is not None and bucket is not None:
            self._client = client
            self._bucket = bucket
        else:
            self._client, self._bucket = _get_client()

    def _key(self, session_id: str) -> str:
        return f"{CONTEXT_PREFIX}{session_id}"

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        try:
            r = self._client.get_object(Bucket=self._bucket, Key=self._key(session_id))
            data = _decode(r["Body"].read())
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def set(self, session_id: str, data: Dict[str, Any]) -> None:
        self._client.put_object(
            Bucket=self._bucket,
            Key=self._key(session_id),
            Body=_encode(data),
            ContentType="application/json; charset=utf-8",
        )


def create_cloud_backend(
    client=None,
    bucket: Optional[str] = None,
) -> StorageBackend:
    """Create cloud backend. If client/bucket omitted, use env (AGENT_STORAGE_BUCKET, etc.)."""
    if client is not None and bucket is not None:
        c, b = client, bucket
    else:
        c, b = _get_client()
    return StorageBackend(
        session_store=CloudSessionStore(c, b),
        memory_store=CloudMemoryStore(c, b),
        skill_store=CloudSkillStore(c, b),
        context_store=CloudContextStore(c, b),
    )
