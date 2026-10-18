# -*- coding: utf-8 -*-
"""No-network checks: default AI engine/model/base_url for container and VM modes.

Run: python3 test_ai_defaults.py
Stubs heavy third-party imports so the repo-root scripts can be exec'ed locally.
"""
import importlib.util
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_KEYS = (
    "AI_ENGINE", "AI_BASE_URL", "AI_API_KEY", "CLOUDFLARE_API_TOKEN",
    "CF_ACCOUNT_ID", "CF_AIG_TOKEN", "BRAIN_AI_MODEL", "AUDITOR_AI_MODEL",
    "DASHSCOPE_API_KEY",
)


def load_module(filename, env):
    """Exec the script under a controlled env; returns (module, openai_calls)."""
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    os.environ.update(env)

    openai_calls = []

    class FakeOpenAI:
        def __init__(self, **kw):
            openai_calls.append(kw)
            self.kw = kw

    mods = {}
    for name in ("openai", "requests", "pandas", "tqdm",
                 "ai_analyst_infra_final", "langchain_huggingface"):
        mods[name] = types.ModuleType(name)
    mods["openai"].OpenAI = FakeOpenAI
    mods["tqdm"].tqdm = lambda x, *a, **k: x
    mods["tqdm"].tqdm.write = print
    mods["ai_analyst_infra_final"].DBLoader = object
    mods["ai_analyst_infra_final"].RAGRetriever = object
    mods["langchain_huggingface"].HuggingFaceEmbeddings = object

    saved = {k: sys.modules.get(k) for k in mods}
    sys.modules.update(mods)
    try:
        spec = importlib.util.spec_from_file_location(
            "mod_under_test", os.path.join(ROOT, filename))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return mod, openai_calls


def client_kwargs(mod, cls_name):
    """Run _init_ai_client on a bare object; returns (client_kw, active_model)."""
    obj = types.SimpleNamespace()
    getattr(mod, cls_name)._init_ai_client(obj)
    return obj.client.kw, obj.active_model


class BrainDefaults(unittest.TestCase):
    FILE = "ai_analyst_Brain_final.py"
    CLS = "AnalystBrain"

    def test_defaults(self):
        mod, _ = load_module(self.FILE, {})
        self.assertEqual(mod.AI_ENGINE, "WORKERS_AI")
        self.assertEqual(mod.WORKERS_AI_MODEL, "dynamic/abc-brain")

    def test_container_mode_uses_ai_internal(self):
        mod, _ = load_module(self.FILE, {"AI_BASE_URL": "http://ai.internal/v1"})
        kw, model = client_kwargs(mod, self.CLS)
        self.assertEqual(kw["base_url"], "http://ai.internal/v1")
        self.assertEqual(kw["api_key"], "unused")
        self.assertEqual(kw["default_headers"], {})
        self.assertEqual(model, "dynamic/abc-brain")

    def test_vm_mode_uses_gateway_compat(self):
        mod, _ = load_module(self.FILE, {
            "CF_ACCOUNT_ID": "acct123", "CF_AIG_TOKEN": "tok456"})
        kw, model = client_kwargs(mod, self.CLS)
        self.assertEqual(
            kw["base_url"],
            "https://gateway.ai.cloudflare.com/v1/acct123/ai-gateway/compat")
        self.assertEqual(
            kw["default_headers"], {"cf-aig-authorization": "Bearer tok456"})
        self.assertEqual(model, "dynamic/abc-brain")

    def test_vm_mode_requires_aig_token(self):
        mod, _ = load_module(self.FILE, {"CF_ACCOUNT_ID": "acct123"})
        with self.assertRaises(SystemExit):
            client_kwargs(mod, self.CLS)


class AuditorDefaults(BrainDefaults):
    FILE = "hotspot_registry_Auditor_final.py"
    CLS = "RegistryAuditor"

    def test_defaults(self):
        mod, _ = load_module(self.FILE, {})
        self.assertEqual(mod.AI_ENGINE, "WORKERS_AI")
        self.assertEqual(mod.WORKERS_AI_MODEL, "dynamic/abc-auditor")

    def test_container_mode_uses_ai_internal(self):
        mod, _ = load_module(self.FILE, {"AI_BASE_URL": "http://ai.internal/v1"})
        kw, model = client_kwargs(mod, self.CLS)
        self.assertEqual(kw["base_url"], "http://ai.internal/v1")
        self.assertEqual(kw["api_key"], "unused")
        self.assertEqual(kw["default_headers"], {})
        self.assertEqual(model, "dynamic/abc-auditor")

    def test_vm_mode_uses_gateway_compat(self):
        mod, _ = load_module(self.FILE, {
            "CF_ACCOUNT_ID": "acct123", "CF_AIG_TOKEN": "tok456"})
        kw, model = client_kwargs(mod, self.CLS)
        self.assertEqual(
            kw["base_url"],
            "https://gateway.ai.cloudflare.com/v1/acct123/ai-gateway/compat")
        self.assertEqual(
            kw["default_headers"], {"cf-aig-authorization": "Bearer tok456"})
        self.assertEqual(model, "dynamic/abc-auditor")


class EngineOverride(unittest.TestCase):
    def test_bailian_still_selectable(self):
        mod, _ = load_module("hotspot_registry_Auditor_final.py", {
            "AI_ENGINE": "BAILIAN", "DASHSCOPE_API_KEY": "k"})
        kw, model = client_kwargs(mod, "RegistryAuditor")
        self.assertEqual(model, "qwen3.5-flash")
        self.assertIn("dashscope.aliyuncs.com", kw["base_url"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
