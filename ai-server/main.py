"""gu「AI 研报」后端 — 包装 tradingAgents-astock 多智能体分析为 HTTP API。

前端 gu(React)通过 `http://<hostname>:8000` 直连本服务(dev=localhost,手机局域网=电脑IP)。
一次只跑一个任务(并发返回 409),后台线程跑 LangGraph stream,进度写入内存 job。

进度检测/阶段定义移植自 tradingAgents-astock 的 `web/runner.py` + `web/progress.py`,
结果 JSON 投影移植自 `examples/run_cases.py` 的 `_save_json_summary`。上游升级时同步这三处。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
import uuid
from datetime import date, datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 启动即加载 .env，让 DEEPSEEK_API_KEY 对 POST 校验和运行线程都可见
load_dotenv(Path(__file__).resolve().parent / ".env")

# ---- 12 阶段定义(移植自 web/progress.py PIPELINE_STAGES) ----
PIPELINE_STAGES: list[dict[str, str]] = [
    {"id": "market", "name": "技术分析", "icon": "📊", "report_key": "market_report"},
    {"id": "social", "name": "情绪分析", "icon": "💬", "report_key": "sentiment_report"},
    {"id": "news", "name": "新闻舆情", "icon": "📰", "report_key": "news_report"},
    {"id": "fundamentals", "name": "基本面", "icon": "📋", "report_key": "fundamentals_report"},
    {"id": "policy", "name": "政策分析", "icon": "🏛️", "report_key": "policy_report"},
    {"id": "hot_money", "name": "游资追踪", "icon": "🔥", "report_key": "hot_money_report"},
    {"id": "lockup", "name": "解禁监控", "icon": "🔒", "report_key": "lockup_report"},
    {"id": "quality_gate", "name": "质量门控", "icon": "✅", "report_key": "data_quality_summary"},
    {"id": "debate", "name": "多空辩论", "icon": "⚔️", "report_key": "investment_plan"},
    {"id": "trader", "name": "交易决策", "icon": "💹", "report_key": "trader_investment_plan"},
    {"id": "risk", "name": "风控评估", "icon": "🛡️", "report_key": "risk_debate_state"},
    {"id": "pm", "name": "最终决策", "icon": "👔", "report_key": "final_trade_decision"},
]
STAGE_IDS = [s["id"] for s in PIPELINE_STAGES]

# 7 个分析师报告键(移植自 web/runner.py)
_ANALYST_REPORT_KEYS = [
    "market_report", "sentiment_report", "news_report",
    "fundamentals_report", "policy_report", "hot_money_report", "lockup_report",
]

# ---- Job 数据结构 ----
@dataclass
class Job:
    id: str
    code: str
    trade_date: str
    status: str = "queued"  # queued / running / done / error
    error: Optional[str] = None
    current_stage: str = ""
    completed: list[str] = field(default_factory=list)
    result: Optional[dict] = None
    created_at: float = field(default_factory=time.time)

    def progress(self) -> list[dict]:
        return [
            {
                "id": s["id"],
                "name": s["name"],
                "icon": s["icon"],
                "status": (
                    "done"
                    if s["id"] in self.completed
                    else ("active" if s["id"] == self.current_stage else "pending")
                ),
            }
            for s in PIPELINE_STAGES
        ]


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()
_CURRENT_JOB_ID: Optional[str] = None

app = FastAPI(title="gu AI 研报服务")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class StartRequest(BaseModel):
    code: str
    date: Optional[str] = None


@app.get("/health")
def health() -> dict:
    return {"ok": True}


def _validate_deepseek_key() -> Optional[str]:
    """返回错误信息字符串；key 有效时返回 None。"""
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        return "未配置 DEEPSEEK_API_KEY。请编辑 ai-server/.env 填入真实 key 后重启服务（npm run ai-server）"
    if key == "你的key" or not key.isascii():
        return "DEEPSEEK_API_KEY 无效（当前是占位符）。请到 platform.deepseek.com 申请真实 key 填入 ai-server/.env 后重启服务"
    return None


@app.post("/api/ai-report")
def start_ai_report(req: StartRequest) -> dict:
    global _CURRENT_JOB_ID
    code = req.code.strip()
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=400, detail="股票代码必须是 6 位数字")
    key_err = _validate_deepseek_key()
    if key_err:
        raise HTTPException(status_code=400, detail=key_err)
    trade_date = req.date or date.today().isoformat()
    with _LOCK:
        if _CURRENT_JOB_ID:
            raise HTTPException(status_code=409, detail="已有任务运行中，请等待完成")
        job = Job(id=uuid.uuid4().hex[:12], code=code, trade_date=trade_date)
        _JOBS[job.id] = job
        _CURRENT_JOB_ID = job.id
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return {"job_id": job.id}


@app.get("/api/ai-report/{job_id}")
def get_job(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    with _LOCK:
        return {
            "status": job.status,
            "current_stage": job.current_stage,
            "progress": job.progress(),
            "error": job.error,
        }


@app.get("/api/ai-report/{job_id}/result")
def get_result(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.status != "done":
        raise HTTPException(status_code=409, detail="任务尚未完成")
    return job.result or {}


# ---- 运行线程(移植自 web/runner.py 的 _run + _detect_completed_stages) ----
def _strip_think_tags(text: str) -> str:
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()


def _detect_completed_stages(chunk: dict[str, Any], job: Job) -> None:
    for report_key in _ANALYST_REPORT_KEYS:
        if chunk.get(report_key) and report_key not in job.completed:
            job.completed.append(report_key)
    if chunk.get("data_quality_summary") and "quality_gate" not in job.completed:
        job.completed.append("quality_gate")
    debate = chunk.get("investment_debate_state") or {}
    if debate.get("judge_decision") and "debate" not in job.completed:
        job.completed.append("debate")
    if chunk.get("trader_investment_plan") and "trader" not in job.completed:
        job.completed.append("trader")
    risk = chunk.get("risk_debate_state") or {}
    if risk.get("judge_decision") and "risk" not in job.completed:
        job.completed.append("risk")
    if chunk.get("final_trade_decision") and "pm" not in job.completed:
        job.completed.append("pm")
    job.current_stage = ""


def _infer_active_stage(job: Job) -> None:
    for sid in STAGE_IDS:
        if sid not in job.completed:
            job.current_stage = sid
            return
    job.current_stage = ""


def _project_summary(job: Job, signal: str, final_state: dict) -> dict:
    """结果 JSON 投影(移植自 examples/run_cases.py _save_json_summary)。"""
    summary: dict[str, Any] = {
        "ticker": job.code,
        "label": job.code,
        "trade_date": job.trade_date,
        "run_time": datetime.now().isoformat(),
        "duration_seconds": round(time.time() - job.created_at),
        "signal": signal,
        "reports": {},
    }
    report_keys = [
        "market_report", "sentiment_report", "news_report", "fundamentals_report",
        "policy_report", "hot_money_report", "lockup_report", "investment_plan",
        "trader_investment_plan", "final_trade_decision",
    ]
    for key in report_keys:
        val = final_state.get(key, "")
        if val:
            summary["reports"][key] = _strip_think_tags(str(val))[:3000]
    debate = final_state.get("investment_debate_state") or {}
    if debate:
        summary["reports"]["bull_history"] = str(debate.get("bull_history", ""))[:2000]
        summary["reports"]["bear_history"] = str(debate.get("bear_history", ""))[:2000]
        summary["reports"]["research_manager"] = str(debate.get("judge_decision", ""))[:2000]
    risk = final_state.get("risk_debate_state") or {}
    if risk:
        summary["reports"]["aggressive_analyst"] = str(risk.get("aggressive_history", ""))[:2000]
        summary["reports"]["conservative_analyst"] = str(risk.get("conservative_history", ""))[:2000]
        summary["reports"]["neutral_analyst"] = str(risk.get("neutral_history", ""))[:2000]
        summary["reports"]["portfolio_manager"] = str(risk.get("judge_decision", ""))[:2000]
    return summary


def _run(job: Job) -> None:
    global _CURRENT_JOB_ID
    graph = None
    try:
        try:
            from tradingagents.default_config import DEFAULT_CONFIG
            from tradingagents.graph.trading_graph import TradingAgentsGraph
        except ImportError as exc:
            raise RuntimeError(
                "无法导入 tradingagents，请先执行: "
                "cd d:/Agent/tradingAgents-astock && pip install -e ."
            ) from exc

        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = "deepseek"
        config["deep_think_llm"] = "deepseek-chat"
        config["quick_think_llm"] = "deepseek-chat"
        config["output_language"] = "Chinese"

        graph = TradingAgentsGraph(debug=True, config=config)
        init_state, args, _ = graph.prepare_graph_run(job.code, job.trade_date)

        last_chunk: dict[str, Any] = {}
        stream = graph.graph.stream(init_state, **args)
        while True:
            try:
                chunk = next(stream)
            except StopIteration:
                break
            last_chunk = chunk
            with _LOCK:
                _detect_completed_stages(chunk, job)
                _infer_active_stage(job)

        if not last_chunk:
            raise RuntimeError("分析没有返回任何结果，请重试")

        signal = graph.finalize_graph_run(job.code, job.trade_date, last_chunk)
        with _LOCK:
            job.result = _project_summary(job, signal, last_chunk)
            job.status = "done"
            job.current_stage = ""
    except Exception as exc:
        traceback.print_exc()
        with _LOCK:
            job.status = "error"
            job.error = str(exc)
    finally:
        if graph is not None:
            try:
                graph.close_graph_run()
            except Exception:
                pass
        with _LOCK:
            _CURRENT_JOB_ID = None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
