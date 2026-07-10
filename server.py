#!/usr/bin/env python3
"""Local ClipRadar server.

Runs a small local-only HTTP server that serves the MVP UI and analyzes Chzzk
VOD chat logs through Naver's public web API endpoints.
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional


ROOT = Path(__file__).resolve().parent
API_BASE = "https://api.chzzk.naver.com"
REACTION_KEYWORDS = [
    "ㅋㅋ",
    "ㅎㅎ",
    "미쳤",
    "레전드",
    "뭐야",
    "헉",
    "와",
    "대박",
    "개웃",
    "웃기",
    "소름",
    "ㄷㄷ",
    "미친",
]
DEFAULT_PREROLL_SECONDS = 30
DEFAULT_POSTROLL_SECONDS = 60
DEFAULT_MERGE_GAP_SECONDS = 90
DEFAULT_MAX_MERGED_CORE_SECONDS = 180


HIGHLIGHT_TYPES = [
    {
        "type": "funny_reaction",
        "label": "웃긴 리액션",
        "keywords": ["ㅋㅋ", "ㅎㅎ", "개웃", "웃기"],
    },
    {
        "type": "hype_reaction",
        "label": "고점 리액션",
        "keywords": ["미쳤", "레전드", "와", "대박", "미친"],
    },
    {
        "type": "surprise",
        "label": "놀람/사건",
        "keywords": ["뭐야", "헉", "소름", "ㄷㄷ"],
    },
]


def extract_video_id(url: str) -> str:
    match = re.search(r"chzzk\.naver\.com/video/(\d+)", url)
    if not match:
        raise ValueError("치지직 VOD URL만 분석할 수 있습니다.")
    return match.group(1)


def fetch_json(url: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
            ),
            "Referer": "https://chzzk.naver.com/",
            "Origin": "https://chzzk.naver.com",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def to_hhmmss(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def scale_spike(spike: float, cap: float = 8.0) -> float:
    if spike <= 1:
        return 0.0
    return max(0.0, min(100.0, (math.log2(spike) / math.log2(cap)) * 100.0))


def keyword_hits(message: str) -> int:
    text = (message or "").lower()
    return sum(1 for keyword in REACTION_KEYWORDS if keyword.lower() in text)


def keyword_counts(message: str) -> Dict[str, int]:
    text = (message or "").lower()
    counts: Dict[str, int] = {}
    for keyword in REACTION_KEYWORDS:
        count = text.count(keyword.lower())
        if count:
            counts[keyword] = count
    return counts


def merge_keyword_counts(items: List[Dict[str, int]]) -> Dict[str, int]:
    merged: Dict[str, int] = {}
    for item in items:
        for keyword, count in item.items():
            merged[keyword] = merged.get(keyword, 0) + int(count)
    return merged


def build_evidence_keywords(keyword_count_map: Dict[str, int], limit: int = 6) -> List[Dict[str, Any]]:
    return [
        {
            "keyword": keyword,
            "count": count,
        }
        for keyword, count in sorted(
            keyword_count_map.items(),
            key=lambda item: (-item[1], REACTION_KEYWORDS.index(item[0]) if item[0] in REACTION_KEYWORDS else 999),
        )
        if count > 0
    ][:limit]


def classify_highlight(keywords: List[str], messages: List[str], title: str = "") -> Dict[str, str]:
    text = " ".join([title, *keywords, *messages]).lower()
    for item in HIGHLIGHT_TYPES:
        if any(keyword.lower() in text for keyword in item["keywords"]):
            return {
                "type": item["type"],
                "label": item["label"],
            }
    return {
        "type": "chat_spike",
        "label": "채팅 급증",
    }


def classify_highlight_with_confidence(
    keyword_count_map: Dict[str, int],
    fallback_keywords: List[str],
    messages: List[str],
    title: str = "",
) -> Dict[str, Any]:
    type_scores = []
    for item in HIGHLIGHT_TYPES:
        score = sum(int(keyword_count_map.get(keyword, 0)) for keyword in item["keywords"])
        type_scores.append(
            {
                "type": item["type"],
                "label": item["label"],
                "score": score,
            }
        )

    evidence_total = sum(item["score"] for item in type_scores)
    if evidence_total > 0:
        best = max(type_scores, key=lambda item: item["score"])
        confidence = round(55 + min(40, (best["score"] / evidence_total) * 40))
        return {
            "type": best["type"],
            "label": best["label"],
            "confidence": confidence,
            "typeScores": type_scores,
        }

    classified = classify_highlight(fallback_keywords, messages, title)
    return {
        "type": classified["type"],
        "label": classified["label"],
        "confidence": 50 if classified["type"] == "chat_spike" else 60,
        "typeScores": type_scores,
    }


def build_cut_range(start: int, end: int, duration_seconds: int) -> Dict[str, Any]:
    cut_start = max(0, int(start) - DEFAULT_PREROLL_SECONDS)
    cut_end = min(int(duration_seconds), int(end) + DEFAULT_POSTROLL_SECONDS)
    return {
        "coreStartTimeSeconds": int(start),
        "coreEndTimeSeconds": int(end),
        "coreStart": to_hhmmss(start),
        "coreEnd": to_hhmmss(end),
        "cutStartTimeSeconds": cut_start,
        "cutEndTimeSeconds": cut_end,
        "cutStart": to_hhmmss(cut_start),
        "cutEnd": to_hhmmss(cut_end),
        "preRollSeconds": int(start) - cut_start,
        "postRollSeconds": cut_end - int(end),
    }


def merge_keywords(moments: List[Dict[str, Any]], limit: int = 8) -> List[str]:
    keywords: List[str] = []
    seen = set()
    for moment in moments:
        for keyword in moment.get("keywords", []):
            if keyword in seen:
                continue
            seen.add(keyword)
            keywords.append(keyword)
            if len(keywords) >= limit:
                return keywords
    return keywords


def merge_chat_samples(moments: List[Dict[str, Any]], limit: int = 5) -> List[Dict[str, str]]:
    samples: List[Dict[str, str]] = []
    seen = set()
    for moment in sorted(moments, key=lambda item: int(item["coreStartTimeSeconds"])):
        for sample in moment.get("representativeChats", []):
            key = (sample.get("time"), sample.get("message"))
            if key in seen:
                continue
            seen.add(key)
            samples.append(sample)
            if len(samples) >= limit:
                return samples
    return samples


def choose_merged_highlight_type(moments: List[Dict[str, Any]], keywords: List[str]) -> Dict[str, Any]:
    scores_by_type: Dict[str, Dict[str, Any]] = {}
    for moment in moments:
        highlight_type = moment.get("highlightType") or ""
        label = moment.get("highlightTypeLabel") or ""
        if not highlight_type or not label:
            continue
        score = float(moment.get("metrics", {}).get("radarScore") or 0)
        entry = scores_by_type.setdefault(
            highlight_type,
            {
                "type": highlight_type,
                "label": label,
                "score": 0.0,
                "confidence": 0.0,
            },
        )
        entry["score"] += score
        entry["confidence"] += float(moment.get("highlightTypeConfidence") or 0)
    if scores_by_type:
        best = max(scores_by_type.values(), key=lambda item: item["score"])
        count = sum(1 for moment in moments if moment.get("highlightType") == best["type"])
        return {
            "type": best["type"],
            "label": best["label"],
            "confidence": round(best["confidence"] / max(count, 1)),
        }
    classified = classify_highlight(keywords, [])
    return {
        "type": classified["type"],
        "label": classified["label"],
        "confidence": 50,
    }


def build_merged_moment(
    moments: List[Dict[str, Any]],
    duration_seconds: int,
    baseline_chat_per_minute: float,
    baseline_keyword_per_minute: float,
) -> Dict[str, Any]:
    ordered = sorted(moments, key=lambda item: int(item["coreStartTimeSeconds"]))
    if len(ordered) == 1:
        single = dict(ordered[0])
        single["mergedSegmentCount"] = 1
        single["mergedSegmentIds"] = [single["id"]]
        return single

    core_start = min(int(moment["coreStartTimeSeconds"]) for moment in ordered)
    core_end = max(int(moment["coreEndTimeSeconds"]) for moment in ordered)
    best_moment = max(ordered, key=lambda item: item.get("metrics", {}).get("radarScore", 0))
    keywords = merge_keywords(ordered)
    highlight_type = choose_merged_highlight_type(ordered, keywords)
    keyword_count_map = merge_keyword_counts([moment.get("keywordCounts", {}) for moment in ordered])
    evidence_keywords = build_evidence_keywords(keyword_count_map)
    representative_chats = merge_chat_samples(ordered)
    cut_range = build_cut_range(core_start, core_end, duration_seconds)

    chat = sum(int(moment.get("chat") or 0) for moment in ordered)
    keyword_hit_count = sum(int(moment.get("keywordHits") or 0) for moment in ordered)
    duration_minutes = max((core_end - core_start) / 60, 0.5)
    chat_per_minute = chat / duration_minutes
    keyword_per_minute = keyword_hit_count / duration_minutes
    chat_spike = chat_per_minute / baseline_chat_per_minute
    keyword_spike = keyword_per_minute / baseline_keyword_per_minute
    chat_score = scale_spike(chat_spike)
    keyword_score = scale_spike(keyword_spike)
    merged_radar_score = round(chat_score * 0.7 + keyword_score * 0.3, 1)
    peak_radar_score = round(
        max(float(moment.get("metrics", {}).get("radarScore") or 0) for moment in ordered),
        1,
    )
    radar_score = max(merged_radar_score, peak_radar_score)

    merged_id = f"{best_moment['id']}-merged-{core_start}-{core_end}"
    return {
        "id": merged_id,
        "title": f"{to_hhmmss(core_start)} {highlight_type['label']} 연속 반응 구간",
        "vodTitle": best_moment.get("vodTitle") or "Untitled",
        "highlightType": highlight_type["type"],
        "highlightTypeLabel": highlight_type["label"],
        "highlightTypeConfidence": highlight_type["confidence"],
        "start": to_hhmmss(core_start),
        "end": to_hhmmss(core_end),
        "watchAt": to_hhmmss(core_start),
        "startTimeSeconds": core_start,
        "endTimeSeconds": core_end,
        **cut_range,
        "durationSeconds": core_end - core_start,
        "chat": chat,
        "clipViews": sum(int(moment.get("clipViews") or 0) for moment in ordered),
        "clips": sum(int(moment.get("clips") or 0) for moment in ordered),
        "keywordHits": keyword_hit_count,
        "keywordCounts": keyword_count_map,
        "evidenceKeywords": evidence_keywords,
        "representativeChats": representative_chats,
        "keywords": keywords,
        "url": best_moment.get("url", ""),
        "mergedSegmentCount": len(ordered),
        "mergedSegmentIds": [moment["id"] for moment in ordered],
        "sourceRanges": [
            {
                "start": moment.get("start"),
                "end": moment.get("end"),
                "radarScore": moment.get("metrics", {}).get("radarScore", 0),
                "highlightTypeLabel": moment.get("highlightTypeLabel", ""),
            }
            for moment in ordered
        ],
        "reason": (
            f"인접한 {len(ordered)}개 반응 신호를 하나로 병합했습니다. "
            f"병합 구간 기준 채팅은 평소 대비 {chat_spike:.1f}배, "
            f"반응 키워드는 {keyword_spike:.1f}배 증가했습니다."
        ),
        "metrics": {
            "chatPerMinute": round(chat_per_minute, 2),
            "chatSpike": round(chat_spike, 2),
            "chatScore": round(chat_score, 1),
            "keywordPerMinute": round(keyword_per_minute, 2),
            "keywordSpike": round(keyword_spike, 2),
            "keywordScore": round(keyword_score, 1),
            "clipReachScore": 0,
            "clipDensityScore": 0,
            "clipImpact": 0,
            "peakRadarScore": peak_radar_score,
            "mergedRadarScore": merged_radar_score,
            "radarScore": radar_score,
        },
    }


def merge_nearby_moments(
    moments: List[Dict[str, Any]],
    duration_seconds: int,
    baseline_chat_per_minute: float,
    baseline_keyword_per_minute: float,
    merge_gap_seconds: int = DEFAULT_MERGE_GAP_SECONDS,
    max_core_seconds: int = DEFAULT_MAX_MERGED_CORE_SECONDS,
) -> List[Dict[str, Any]]:
    if not moments:
        return []

    merged: List[Dict[str, Any]] = []
    current_group: List[Dict[str, Any]] = []
    current_url = ""
    current_start = 0
    current_end = 0

    for moment in sorted(moments, key=lambda item: (item.get("url", ""), int(item["coreStartTimeSeconds"]))):
        start = int(moment["coreStartTimeSeconds"])
        end = int(moment["coreEndTimeSeconds"])
        url = moment.get("url", "")
        merged_duration = max(current_end, end) - min(current_start, start)
        should_merge = (
            current_group
            and url == current_url
            and start <= current_end + merge_gap_seconds
            and merged_duration <= max_core_seconds
        )
        if not should_merge and current_group:
            merged.append(
                build_merged_moment(
                    current_group,
                    duration_seconds,
                    baseline_chat_per_minute,
                    baseline_keyword_per_minute,
                )
            )
            current_group = []

        if not current_group:
            current_url = url
            current_start = start
            current_end = end
        else:
            current_start = min(current_start, start)
            current_end = max(current_end, end)
        current_group.append(moment)

    if current_group:
        merged.append(
            build_merged_moment(
                current_group,
                duration_seconds,
                baseline_chat_per_minute,
                baseline_keyword_per_minute,
            )
        )
    return merged


def fetch_metadata(video_id: str) -> Dict[str, Any]:
    data = fetch_json(f"{API_BASE}/service/v2/videos/{video_id}")
    content = data.get("content") or {}
    if not content:
        raise ValueError("VOD 메타데이터를 가져오지 못했습니다.")
    return content


def normalize_chats(raw_chats: List[Dict[str, Any]], duration_ms: int) -> List[Dict[str, Any]]:
    chats_out: List[Dict[str, Any]] = []
    for chat in raw_chats:
        pm = int(chat.get("playerMessageTime") or 0)
        if 0 <= pm <= duration_ms:
            chats_out.append(
                {
                    "timeMs": pm,
                    "time": to_hhmmss(pm // 1000),
                    "message": chat.get("content") or "",
                    "messageTypeCode": chat.get("messageTypeCode"),
                    "userIdHash": chat.get("userIdHash"),
                }
            )
    return chats_out


def dedupe_chats(chats: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    dedup: Dict[tuple, Dict[str, Any]] = {}
    for chat in chats:
        key = (chat["timeMs"], chat["userIdHash"], chat["message"])
        dedup[key] = chat
    return sorted(dedup.values(), key=lambda item: item["timeMs"])


def fetch_chat_page(video_id: str, duration_ms: int, player_message_time: int) -> List[Dict[str, Any]]:
    url = f"{API_BASE}/service/v1/videos/{video_id}/chats?playerMessageTime={player_message_time}"
    data = fetch_json(url)
    raw_chats = ((data.get("content") or {}).get("videoChats")) or []
    return normalize_chats(raw_chats, duration_ms)


def fetch_chats_sampled(
    video_id: str,
    duration_ms: int,
    sample_pages: int = 36,
    workers: int = 6,
) -> List[Dict[str, Any]]:
    """Fetch representative chat pages across the whole VOD for fast analysis."""
    sample_pages = max(8, min(int(sample_pages), 96))
    workers = max(1, min(int(workers), 8))
    last_ms = max(duration_ms - 1, 0)
    if sample_pages == 1 or last_ms <= 0:
        positions = [0]
    else:
        positions = sorted(
            set(round(index * last_ms / (sample_pages - 1)) for index in range(sample_pages))
        )

    chats_out: List[Dict[str, Any]] = []
    errors: List[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(fetch_chat_page, video_id, duration_ms, position)
            for position in positions
        ]
        for future in as_completed(futures):
            try:
                chats_out.extend(future.result())
            except Exception as exc:
                errors.append(str(exc))

    if not chats_out and errors:
        raise RuntimeError(errors[0])
    return dedupe_chats(chats_out)


def fetch_chats(
    video_id: str,
    duration_ms: int,
    page_delay: float = 0.06,
    max_pages: Optional[int] = None,
) -> List[Dict[str, Any]]:
    chats_out: List[Dict[str, Any]] = []
    ti = 0
    empty_retry = 0
    last_progress_time = -1
    stall_retry = 0

    page = 0

    while ti <= duration_ms:
        if max_pages is not None and page >= max_pages:
            break
        chats = fetch_chat_page(video_id, duration_ms, ti)

        if not chats:
            empty_retry += 1
            if empty_retry >= 3:
                break
            time.sleep(max(page_delay, 0.2))
            continue
        empty_retry = 0
        chats_out.extend(chats)
        last_time = int(chats[-1].get("timeMs") or ti)
        if last_time == last_progress_time:
            stall_retry += 1
            ti = last_time + 1
            if stall_retry >= 3:
                ti += 1
                stall_retry = 0
        else:
            ti = last_time + 1
            last_progress_time = last_time
            stall_retry = 0

        page += 1
        time.sleep(page_delay)

    return dedupe_chats(chats_out)


def median_baseline(values: List[float], fallback: float = 0.1) -> float:
    clean = sorted(value for value in values if value > 0)
    if not clean:
        return fallback
    mid = len(clean) // 2
    if len(clean) % 2:
        return max(clean[mid], fallback)
    return max((clean[mid - 1] + clean[mid]) / 2, fallback)


def analyze_chats(
    *,
    vod_url: str,
    bucket_seconds: int = 30,
    top_n: int = 10,
    max_pages: Optional[int] = None,
    scan_mode: str = "quick",
    sample_pages: int = 36,
) -> Dict[str, Any]:
    video_id = extract_video_id(vod_url)
    metadata = fetch_metadata(video_id)
    duration_seconds = int(metadata.get("duration") or 0)
    if duration_seconds <= 0:
        raise ValueError("VOD 길이를 확인하지 못했습니다.")

    duration_ms = duration_seconds * 1000
    is_limited_test = max_pages is not None
    scan_mode = str(scan_mode or "quick").lower()
    use_quick_scan = not is_limited_test and scan_mode != "full"
    if use_quick_scan:
        chats = fetch_chats_sampled(video_id, duration_ms, sample_pages=sample_pages)
    else:
        chats = fetch_chats(video_id, duration_ms, max_pages=max_pages)
    bucket_seconds = max(10, min(int(bucket_seconds), 120))
    bucket_count = max(1, math.ceil(duration_seconds / bucket_seconds))
    buckets = [
        {
            "index": idx,
            "start": idx * bucket_seconds,
            "end": min(duration_seconds, (idx + 1) * bucket_seconds),
            "chat": 0,
            "keywordHits": 0,
            "keywordCounts": {},
            "messages": [],
            "representativeChats": [],
        }
        for idx in range(bucket_count)
    ]

    for chat in chats:
        idx = min(bucket_count - 1, max(0, int((chat["timeMs"] / 1000) // bucket_seconds)))
        buckets[idx]["chat"] += 1
        chat_message = chat["message"]
        counts = keyword_counts(chat_message)
        hit_count = sum(counts.values())
        buckets[idx]["keywordHits"] += hit_count
        for keyword, count in counts.items():
            buckets[idx]["keywordCounts"][keyword] = buckets[idx]["keywordCounts"].get(keyword, 0) + count
        if hit_count and len(buckets[idx]["messages"]) < 5:
            buckets[idx]["messages"].append(chat_message)
        if chat_message and len(buckets[idx]["representativeChats"]) < 5:
            buckets[idx]["representativeChats"].append(
                {
                    "time": chat.get("time") or to_hhmmss(int(chat.get("timeMs") or 0) // 1000),
                    "message": chat_message[:140],
                    "matchedKeywords": list(counts.keys())[:4],
                }
            )

    duration_minutes = max(duration_seconds / 60, 1)
    if use_quick_scan:
        chat_rates = []
        keyword_rates = []
        for bucket in buckets:
            window_minutes = max((bucket["end"] - bucket["start"]) / 60, 0.5)
            if bucket["chat"]:
                chat_rates.append(bucket["chat"] / window_minutes)
            if bucket["keywordHits"]:
                keyword_rates.append(bucket["keywordHits"] / window_minutes)
        baseline_chat_per_minute = median_baseline(chat_rates)
        baseline_keyword_per_minute = median_baseline(keyword_rates)
    else:
        baseline_chat_per_minute = len(chats) / duration_minutes
        baseline_keyword_per_minute = sum(bucket["keywordHits"] for bucket in buckets) / duration_minutes
    baseline_chat_per_minute = max(baseline_chat_per_minute, 0.1)
    baseline_keyword_per_minute = max(baseline_keyword_per_minute, 0.1)

    raw_moments = []
    for bucket in buckets:
        window_minutes = max((bucket["end"] - bucket["start"]) / 60, 0.5)
        chat_per_minute = bucket["chat"] / window_minutes
        keyword_per_minute = bucket["keywordHits"] / window_minutes
        chat_spike = chat_per_minute / baseline_chat_per_minute
        keyword_spike = keyword_per_minute / baseline_keyword_per_minute
        chat_score = scale_spike(chat_spike)
        keyword_score = scale_spike(keyword_spike)
        radar_score = round(chat_score * 0.7 + keyword_score * 0.3, 1)
        if bucket["chat"] < 3 and bucket["keywordHits"] < 1:
            continue
        if radar_score <= 0:
            continue

        keywords = [
            keyword
            for keyword in REACTION_KEYWORDS
            if any(keyword.lower() in message.lower() for message in bucket["messages"])
        ][:6]
        if not keywords and bucket["keywordHits"]:
            keywords = ["반응 급증"]

        title_hint = f"{to_hhmmss(bucket['start'])} 채팅 반응 구간"
        highlight_type = classify_highlight_with_confidence(
            bucket["keywordCounts"],
            keywords,
            bucket["messages"],
            title_hint,
        )
        cut_range = build_cut_range(bucket["start"], bucket["end"], duration_seconds)
        title = f"{to_hhmmss(bucket['start'])} {highlight_type['label']} 구간"

        raw_moments.append(
            {
                "id": f"{video_id}-{bucket['start']}-{bucket['end']}",
                "title": title,
                "vodTitle": metadata.get("videoTitle") or metadata.get("title") or "Untitled",
                "highlightType": highlight_type["type"],
                "highlightTypeLabel": highlight_type["label"],
                "highlightTypeConfidence": highlight_type["confidence"],
                "highlightTypeScores": highlight_type["typeScores"],
                "start": to_hhmmss(bucket["start"]),
                "end": to_hhmmss(bucket["end"]),
                "watchAt": to_hhmmss(bucket["start"]),
                "startTimeSeconds": bucket["start"],
                "endTimeSeconds": bucket["end"],
                **cut_range,
                "durationSeconds": bucket["end"] - bucket["start"],
                "chat": bucket["chat"],
                "clipViews": 0,
                "clips": 0,
                "keywordHits": bucket["keywordHits"],
                "keywordCounts": bucket["keywordCounts"],
                "evidenceKeywords": build_evidence_keywords(bucket["keywordCounts"]),
                "representativeChats": bucket["representativeChats"],
                "keywords": keywords,
                "url": vod_url,
                "reason": (
                    f"평소 대비 채팅이 {chat_spike:.1f}배, "
                    f"반응 키워드가 {keyword_spike:.1f}배 증가했습니다."
                ),
                "metrics": {
                    "chatPerMinute": round(chat_per_minute, 2),
                    "chatSpike": round(chat_spike, 2),
                    "chatScore": round(chat_score, 1),
                    "keywordPerMinute": round(keyword_per_minute, 2),
                    "keywordSpike": round(keyword_spike, 2),
                    "keywordScore": round(keyword_score, 1),
                    "clipReachScore": 0,
                    "clipDensityScore": 0,
                    "clipImpact": 0,
                    "radarScore": radar_score,
                },
            }
        )

    merged_moments = merge_nearby_moments(
        raw_moments,
        duration_seconds,
        baseline_chat_per_minute,
        baseline_keyword_per_minute,
    )
    merged_moments.sort(key=lambda item: item["metrics"]["radarScore"], reverse=True)
    moments = merged_moments[: max(1, min(int(top_n), 30))]
    for idx, moment in enumerate(moments, start=1):
        moment["rank"] = idx

    confidence = calculate_confidence(moments)
    channel = metadata.get("channel") or {}
    streamer_name = channel.get("channelName") or metadata.get("channelName") or "Unknown"
    channel_id = channel.get("channelId") or metadata.get("channelId") or ""
    publish_date = (
        metadata.get("openDate")
        or metadata.get("publishDate")
        or metadata.get("createdDate")
        or ""
    )

    video = {
        "id": video_id,
        "url": vod_url,
        "title": metadata.get("videoTitle") or metadata.get("title") or "Untitled",
        "durationSeconds": duration_seconds,
        "thumbnail": metadata.get("thumbnailImageUrl") or metadata.get("thumbnailUrl") or "",
        "publishDate": publish_date,
    }

    return {
        "schemaVersion": "clipradar.report.v1",
        "app": "ClipRadar",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "type": "chzzk-vod",
            "dataMode": (
                "chat-precise-sampled"
                if scan_mode == "precise" and use_quick_scan
                else "chat-sampled"
                if use_quick_scan
                else "chat-limited"
                if is_limited_test
                else "chat-full"
            ),
            "hasChatData": True,
            "hasClipData": False,
        },
        "video": video,
        "videos": [video],
        "streamer": {
            "name": streamer_name,
            "channelId": channel_id,
            "profileImageUrl": channel.get("channelImageUrl") or "",
            "verified": bool(channel.get("verifiedMark")),
            "channelUrl": f"https://chzzk.naver.com/{channel_id}" if channel_id else "",
        },
        "analysis": {
            "bucketSeconds": bucket_seconds,
            "scanMode": scan_mode if use_quick_scan else "limited" if is_limited_test else "full",
            "samplePages": sample_pages if use_quick_scan else None,
            "chatCount": len(chats),
            "candidateCount": len(moments),
            "rawCandidateCount": len(raw_moments),
            "mergedCandidateCount": len(merged_moments),
            "mergeGapSeconds": DEFAULT_MERGE_GAP_SECONDS,
            "maxMergedCoreSeconds": DEFAULT_MAX_MERGED_CORE_SECONDS,
            "baseline": {
                "chatPerMinute": round(baseline_chat_per_minute, 2),
                "keywordHitsPerMinute": round(baseline_keyword_per_minute, 2),
                "clipCountPerHour": 0,
            },
            "confidenceScore": confidence,
            "confidenceGuide": "레이더 신뢰도는 선택된 후보에서 채팅 급증과 반응 키워드 급증이 함께 강하고 서로 비슷한 수준으로 나타나는지 계산합니다. 클립 데이터는 현재 신뢰도에 포함하지 않습니다.",
            "scoringModel": {
                "mode": "chat-only",
                "radarScore": "채팅 급증도 70% + 키워드 급증도 30%",
                "chatSpike": (
                    "구간의 샘플 채팅량 / 수집된 샘플 내 기준 채팅량"
                    if use_quick_scan
                    else "구간 분당 채팅량 / VOD 전체 평균 분당 채팅량"
                ),
                "keywordSpike": (
                    "구간의 샘플 반응 키워드 수 / 수집된 샘플 내 기준 키워드 수"
                    if use_quick_scan
                    else "구간 분당 반응 키워드 수 / VOD 전체 평균 분당 반응 키워드 수"
                ),
            },
        },
        "moments": moments,
    }


def calculate_confidence(moments: List[Dict[str, Any]]) -> int:
    """Measure agreement and strength of the available chat-only signals."""
    if not moments:
        return 0

    def signal_strength(spike: float) -> float:
        if spike >= 3.0:
            return 1.0
        if spike >= 2.0:
            return 0.85
        if spike >= 1.5:
            return 0.65
        if spike >= 1.2:
            return 0.45
        return 0.25

    scores = []
    for moment in moments:
        metrics = moment["metrics"]
        chat_signal = signal_strength(float(metrics.get("chatSpike") or 0))
        keyword_signal = signal_strength(float(metrics.get("keywordSpike") or 0))
        strength = (chat_signal + keyword_signal) / 2
        agreement = 1 - abs(chat_signal - keyword_signal)
        scores.append(strength * (0.75 + agreement * 0.25))
    return round(sum(scores) / len(scores) * 100)


def unique_urls(values: List[str]) -> List[str]:
    urls: List[str] = []
    seen = set()
    for value in values:
        url = str(value or "").strip()
        if not url or url in seen:
            continue
        extract_video_id(url)
        seen.add(url)
        urls.append(url)
    return urls


def average(values: List[float], fallback: float = 0.0) -> float:
    clean = [value for value in values if value is not None]
    if not clean:
        return fallback
    return sum(clean) / len(clean)


def analyze_weekly_report(
    *,
    vod_urls: List[str],
    bucket_seconds: int = 30,
    top_n: int = 20,
    scan_mode: str = "quick",
    sample_pages: int = 24,
) -> Dict[str, Any]:
    urls = unique_urls(vod_urls)
    if not urls:
        raise ValueError("분석할 치지직 VOD URL을 입력해주세요.")

    reports: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    scan_mode = str(scan_mode or "quick").lower()
    workers = min(2, len(urls))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                analyze_chats,
                vod_url=url,
                bucket_seconds=bucket_seconds,
                top_n=max(8, min(top_n, 20)),
                scan_mode=scan_mode,
                sample_pages=sample_pages,
            ): url
            for url in urls
        }
        for future in as_completed(futures):
            url = futures[future]
            try:
                reports.append(future.result())
            except Exception as exc:
                errors.append({"url": url, "error": str(exc)})

    if not reports:
        detail = errors[0]["error"] if errors else "분석 가능한 VOD가 없습니다."
        raise ValueError(detail)

    videos = [report["video"] for report in reports]
    moments: List[Dict[str, Any]] = []
    vod_summaries: List[Dict[str, Any]] = []
    for report in reports:
        video = report["video"]
        report_moments = report.get("moments", [])
        top_moment = report_moments[0] if report_moments else {}
        vod_summaries.append(
            {
                "videoId": video["id"],
                "title": video["title"],
                "url": video["url"],
                "publishDate": video.get("publishDate", ""),
                "durationSeconds": video.get("durationSeconds", 0),
                "thumbnail": video.get("thumbnail", ""),
                "chatCount": report.get("analysis", {}).get("chatCount", 0),
                "candidateCount": report.get("analysis", {}).get("candidateCount", 0),
                "rawCandidateCount": report.get("analysis", {}).get("rawCandidateCount", 0),
                "mergedCandidateCount": report.get("analysis", {}).get("mergedCandidateCount", 0),
                "confidenceScore": report.get("analysis", {}).get("confidenceScore", 0),
                "topScore": top_moment.get("metrics", {}).get("radarScore", 0),
                "topMomentTitle": top_moment.get("title", ""),
                "topMomentStart": top_moment.get("start", ""),
            }
        )
        for moment in report.get("moments", []):
            item = dict(moment)
            item.update(
                {
                    "id": f"{video['id']}-{moment.get('startTimeSeconds', moment.get('start'))}",
                    "videoId": video["id"],
                    "videoTitle": video["title"],
                    "videoUrl": video["url"],
                    "videoThumbnail": video.get("thumbnail", ""),
                    "publishDate": video.get("publishDate", ""),
                    "url": moment.get("url") or video["url"],
                    "sourceRank": moment.get("rank"),
                }
            )
            moments.append(item)

    moments.sort(key=lambda item: item.get("metrics", {}).get("radarScore", 0), reverse=True)
    moments = moments[: max(1, min(int(top_n), 50))]
    for idx, moment in enumerate(moments, start=1):
        moment["rank"] = idx

    streamer_names = sorted({report.get("streamer", {}).get("name", "Unknown") for report in reports})
    if len(streamer_names) == 1:
        streamer_name = streamer_names[0]
        channel_id = reports[0].get("streamer", {}).get("channelId", "")
        profile_image_url = reports[0].get("streamer", {}).get("profileImageUrl", "")
        verified = bool(reports[0].get("streamer", {}).get("verified"))
        channel_url = reports[0].get("streamer", {}).get("channelUrl", "")
    else:
        streamer_name = "주간 묶음 리포트"
        channel_id = ""
        profile_image_url = ""
        verified = False
        channel_url = ""

    publish_dates = [video.get("publishDate", "") for video in videos if video.get("publishDate")]
    period = " - ".join([min(publish_dates), max(publish_dates)]) if publish_dates else ""
    total_chat_count = sum(int(report.get("analysis", {}).get("chatCount") or 0) for report in reports)
    total_candidate_count = sum(
        int(report.get("analysis", {}).get("candidateCount") or 0) for report in reports
    )
    total_raw_candidate_count = sum(
        int(report.get("analysis", {}).get("rawCandidateCount") or 0) for report in reports
    )
    total_merged_candidate_count = sum(
        int(report.get("analysis", {}).get("mergedCandidateCount") or 0) for report in reports
    )
    baseline_chat = average(
        [
            float(report.get("analysis", {}).get("baseline", {}).get("chatPerMinute") or 0)
            for report in reports
        ],
        fallback=0.1,
    )
    baseline_keyword = average(
        [
            float(report.get("analysis", {}).get("baseline", {}).get("keywordHitsPerMinute") or 0)
            for report in reports
        ],
        fallback=0.1,
    )

    return {
        "schemaVersion": "clipradar.report.v1",
        "app": "ClipRadar",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "type": "chzzk-weekly",
            "dataMode": (
                "weekly-chat-precise-sampled"
                if scan_mode == "precise"
                else "weekly-chat-sampled"
                if scan_mode != "full"
                else "weekly-chat-full"
            ),
            "hasChatData": True,
            "hasClipData": False,
        },
        "video": {
            "id": "weekly",
            "url": videos[0]["url"],
            "title": f"{streamer_name} 주간 하이라이트",
            "durationSeconds": sum(int(video.get("durationSeconds") or 0) for video in videos),
            "thumbnail": videos[0].get("thumbnail", ""),
            "publishDate": period,
        },
        "videos": videos,
        "streamer": {
            "name": streamer_name,
            "channelId": channel_id,
            "profileImageUrl": profile_image_url,
            "verified": verified,
            "channelUrl": channel_url,
        },
        "analysis": {
            "reportType": "weekly",
            "bucketSeconds": bucket_seconds,
            "scanMode": scan_mode if scan_mode != "full" else "full",
            "samplePages": sample_pages if scan_mode != "full" else None,
            "vodCount": len(reports),
            "requestedVodCount": len(urls),
            "failedVodCount": len(errors),
            "errors": errors,
            "vodSummaries": vod_summaries,
            "chatCount": total_chat_count,
            "candidateCount": len(moments),
            "vodCandidateCount": total_candidate_count,
            "rawCandidateCount": total_raw_candidate_count,
            "mergedCandidateCount": total_merged_candidate_count,
            "mergeGapSeconds": DEFAULT_MERGE_GAP_SECONDS,
            "maxMergedCoreSeconds": DEFAULT_MAX_MERGED_CORE_SECONDS,
            "baseline": {
                "chatPerMinute": round(baseline_chat, 2),
                "keywordHitsPerMinute": round(baseline_keyword, 2),
                "clipCountPerHour": 0,
            },
            "confidenceScore": calculate_confidence(moments),
            "confidenceGuide": "주간 분석은 각 VOD를 자기 평균 기준으로 먼저 분석한 뒤, 점수가 높은 구간만 합쳐 주간 TOP 후보를 만듭니다.",
            "scoringModel": {
                "mode": "weekly-chat-only",
                "radarScore": "각 VOD 내부 기준 채팅 급증도 70% + 키워드 급증도 30%",
                "chatSpike": "구간 분당 채팅량 / 해당 VOD 평균 또는 샘플 기준 분당 채팅량",
                "keywordSpike": "구간 분당 반응 키워드 수 / 해당 VOD 평균 또는 샘플 기준 반응 키워드 수",
            },
        },
        "moments": moments,
    }


class ClipRadarHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/analyze":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            raw_urls = payload.get("urls")
            if raw_urls is None:
                raw_url = payload.get("url", "")
                raw_urls = re.split(r"[\n,\s]+", raw_url) if isinstance(raw_url, str) else [raw_url]
            urls = unique_urls(raw_urls)
            if len(urls) > 1:
                report = analyze_weekly_report(
                    vod_urls=urls,
                    bucket_seconds=int(payload.get("bucketSeconds", 30)),
                    top_n=int(payload.get("topN", 20)),
                    scan_mode=payload.get("scanMode", "quick"),
                    sample_pages=int(payload.get("samplePages", 24)),
                )
            else:
                report = analyze_chats(
                    vod_url=urls[0] if urls else "",
                    bucket_seconds=int(payload.get("bucketSeconds", 30)),
                    top_n=int(payload.get("topN", 10)),
                    max_pages=payload.get("maxPages"),
                    scan_mode=payload.get("scanMode", "quick"),
                    sample_pages=int(payload.get("samplePages", 36)),
                )
            body = json.dumps(report, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 5173), ClipRadarHandler)
    print("ClipRadar running at http://localhost:5173")
    server.serve_forever()


if __name__ == "__main__":
    main()
