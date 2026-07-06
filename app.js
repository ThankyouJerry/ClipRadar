const SCORE_WEIGHTS = {
  full: {
    chatSpike: 0.4,
    clipReach: 0.25,
    clipDensity: 0.2,
    keywordSpike: 0.15
  },
  chatOnly: {
    chatSpike: 0.7,
    keywordSpike: 0.3
  }
};

const DEFAULT_PREROLL_SECONDS = 30;
const DEFAULT_POSTROLL_SECONDS = 60;

const state = {
  reports: buildInitialReports(),
  activeReportIndex: 0,
  sortBy: "score",
  timelineVideoId: "all",
  analysisMode: "quick",
  reviewStates: {}
};

const $ = (selector) => document.querySelector(selector);

function buildInitialReports() {
  return window.CLIP_RADAR_DATA.streamers.map((streamer) => sampleStreamerToReport(streamer));
}

function sampleStreamerToReport(streamer) {
  const moments = streamer.moments.map((moment, index) => ({
    id: `${streamer.id}-${index + 1}`,
    rank: index + 1,
    title: moment.title,
    vodTitle: moment.vodTitle,
    start: moment.start,
    end: moment.end,
    watchAt: moment.watchAt,
    startTimeSeconds: parseTimeToSeconds(moment.start),
    endTimeSeconds: parseTimeToSeconds(moment.end),
    durationSeconds: Math.max(parseTimeToSeconds(moment.end) - parseTimeToSeconds(moment.start), 1),
    chat: moment.chat,
    clips: moment.clips,
    clipViews: moment.clipViews,
    keywordHits: moment.keywordHits || moment.keywords.length,
    keywords: moment.keywords,
    url: moment.url,
    reason: moment.reason
  }));

  return {
    schemaVersion: "clipradar.report.v1",
    app: "ClipRadar",
    generatedAt: window.CLIP_RADAR_DATA.generatedAt,
    source: {
      type: "sample",
      dataMode: "chat-clip-sample",
      hasChatData: true,
      hasClipData: true
    },
    video: {
      id: streamer.id,
      url: "https://chzzk.naver.com/",
      title: `${streamer.name} 샘플 주간 리포트`,
      durationSeconds: 0,
      thumbnail: "",
      publishDate: streamer.period
    },
    streamer: {
      name: streamer.name,
      channelId: streamer.id,
      profileImageUrl: streamer.profileImageUrl || "",
      verified: Boolean(streamer.verified),
      channelUrl: streamer.channelUrl || ""
    },
    analysis: {
      bucketSeconds: 30,
      chatCount: streamer.moments.reduce((sum, item) => sum + item.chat, 0),
      clipCount: streamer.clipCount,
      candidateCount: streamer.candidateCount,
      baseline: streamer.baseline,
      confidenceScore: streamer.confidence,
      confidenceGuide: "샘플 데이터 기준 신뢰도입니다.",
      scoringModel: {
        mode: "chat-clip",
        radarScore: "채팅 급증도 40% + 클립 조회 영향 25% + 클립 생성 밀도 20% + 키워드 급증도 15%",
        chatSpike: "구간 분당 채팅량 / 스트리머 평소 분당 채팅량",
        clipImpact: "클립 조회 영향 60% + 클립 생성 밀도 40%"
      }
    },
    moments
  };
}

function parseTimeToSeconds(time) {
  if (typeof time === "number") return time;
  return String(time || "0").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function formatSeconds(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function buildTimedChzzkUrl(url, seconds) {
  const baseUrl = String(url || "").trim();
  if (!baseUrl) return "";
  const timestamp = formatSeconds(seconds);
  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.delete("t");
    const params = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${params ? `?${params}&` : "?"}t=${timestamp}${parsed.hash}`;
  } catch (_) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}t=${timestamp}`;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("ko-KR").format(value || 0);
}

function formatDecimal(value, digits = 1) {
  return Number(value || 0).toFixed(digits);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scaleSpike(spike, cap = 8) {
  if (spike <= 1) return 0;
  return clamp((Math.log2(spike) / Math.log2(cap)) * 100, 0, 100);
}

function getDurationMinutes(moment) {
  const durationSeconds =
    moment.durationSeconds ||
    Math.max(parseTimeToSeconds(moment.end) - parseTimeToSeconds(moment.start), 1);
  return Math.max(durationSeconds / 60, 0.5);
}

function getActiveReport() {
  return state.reports[state.activeReportIndex];
}

function getReportVideoCount(report) {
  return report.videos?.length || report.analysis?.vodCount || 1;
}

function isWeeklyReport(report) {
  return getReportVideoCount(report) > 1 || report.analysis?.reportType === "weekly";
}

function getReportVideos(report) {
  if (report.videos?.length) return report.videos;
  return [report.video].filter(Boolean);
}

function getReportTitle(report) {
  const count = getReportVideoCount(report);
  if (count > 1) return `${report.video.title} (${count}개 VOD)`;
  return report.video.title;
}

function getVideoTabLabel(video, index) {
  const date = String(video.publishDate || "").split(" ")[0].replaceAll("-", ".");
  return date || `VOD ${index + 1}`;
}

function getInputUrls() {
  return $("#vodUrlInput").value
    .split(/[\n,\s]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function hasClipData(report) {
  return Boolean(report.source?.hasClipData);
}

function getReportKey(report) {
  return [
    report.generatedAt,
    report.video?.id,
    report.streamer?.channelId || report.streamer?.name
  ].filter(Boolean).join(":");
}

function getReviewState(report) {
  const key = getReportKey(report);
  if (!state.reviewStates[key]) {
    state.reviewStates[key] = {
      pinned: new Set(),
      excluded: new Set(),
      showExcluded: false
    };
  }
  return state.reviewStates[key];
}

function getMomentReviewStatus(report, moment) {
  const review = getReviewState(report);
  if (review.excluded.has(moment.id)) return "excluded";
  if (review.pinned.has(moment.id)) return "pinned";
  return "candidate";
}

function formatReviewStatus(status) {
  return {
    pinned: "고정",
    excluded: "제외",
    candidate: "후보"
  }[status] || "후보";
}

function togglePinned(report, moment) {
  const review = getReviewState(report);
  if (review.pinned.has(moment.id)) {
    review.pinned.delete(moment.id);
  } else {
    review.excluded.delete(moment.id);
    review.pinned.add(moment.id);
  }
  render();
}

function toggleExcluded(report, moment) {
  const review = getReviewState(report);
  if (review.excluded.has(moment.id)) {
    review.excluded.delete(moment.id);
  } else {
    review.pinned.delete(moment.id);
    review.excluded.add(moment.id);
  }
  render();
}

function toggleExcludedVisibility() {
  const report = getActiveReport();
  const review = getReviewState(report);
  review.showExcluded = !review.showExcluded;
  render();
}

function getReviewCounts(report) {
  const review = getReviewState(report);
  return {
    pinned: review.pinned.size,
    excluded: review.excluded.size,
    showExcluded: review.showExcluded
  };
}

function getTypeConfidence(moment) {
  if (moment.highlightTypeConfidence !== undefined) return Math.round(Number(moment.highlightTypeConfidence) || 0);
  const keywords = moment.evidenceKeywords || [];
  if (!keywords.length) return 50;
  return Math.min(90, 55 + keywords.length * 8);
}

function getEvidenceKeywords(moment) {
  if (moment.evidenceKeywords?.length) return moment.evidenceKeywords;
  return (moment.keywords || []).slice(0, 6).map((keyword) => ({
    keyword,
    count: 1
  }));
}

function getRepresentativeChats(moment) {
  if (moment.representativeChats?.length) return moment.representativeChats;
  return (moment.keywords || []).slice(0, 3).map((keyword, index) => ({
    time: moment.watchAt || moment.start || formatSeconds(moment.startTimeSeconds),
    message: `${keyword} 반응이 감지된 구간입니다.`,
    matchedKeywords: [keyword],
    fallback: true,
    id: `fallback-${index}`
  }));
}

function inferHighlightType(moment) {
  const text = [
    moment.title,
    moment.reason,
    ...(moment.keywords || [])
  ].join(" ").toLowerCase();
  const rules = [
    { type: "funny_reaction", label: "웃긴 리액션", keywords: ["ㅋㅋ", "ㅎㅎ", "개웃", "웃기", "웃음"] },
    { type: "hype_reaction", label: "고점 리액션", keywords: ["미쳤", "레전드", "와", "대박", "미친"] },
    { type: "surprise", label: "놀람/사건", keywords: ["뭐야", "헉", "소름", "ㄷㄷ"] }
  ];
  return rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword))) || {
    type: "chat_spike",
    label: "채팅 급증"
  };
}

function getHighlightType(moment) {
  const inferred = inferHighlightType(moment);
  return {
    type: moment.highlightType || inferred.type,
    label: moment.highlightTypeLabel || inferred.label
  };
}

function getMomentRanges(moment) {
  const coreStartSeconds =
    moment.coreStartTimeSeconds ??
    moment.startTimeSeconds ??
    parseTimeToSeconds(moment.coreStart || moment.start);
  const coreEndSeconds =
    moment.coreEndTimeSeconds ??
    moment.endTimeSeconds ??
    parseTimeToSeconds(moment.coreEnd || moment.end);
  const preRollSeconds = moment.preRollSeconds ?? DEFAULT_PREROLL_SECONDS;
  const postRollSeconds = moment.postRollSeconds ?? DEFAULT_POSTROLL_SECONDS;
  const cutStartSeconds =
    moment.cutStartTimeSeconds ?? Math.max(0, coreStartSeconds - preRollSeconds);
  const cutEndSeconds =
    moment.cutEndTimeSeconds ?? Math.max(cutStartSeconds + 1, coreEndSeconds + postRollSeconds);

  return {
    coreStartTimeSeconds: coreStartSeconds,
    coreEndTimeSeconds: coreEndSeconds,
    coreStart: moment.coreStart || moment.start || formatSeconds(coreStartSeconds),
    coreEnd: moment.coreEnd || moment.end || formatSeconds(coreEndSeconds),
    cutStartTimeSeconds: cutStartSeconds,
    cutEndTimeSeconds: cutEndSeconds,
    cutStart: moment.cutStart || formatSeconds(cutStartSeconds),
    cutEnd: moment.cutEnd || formatSeconds(cutEndSeconds),
    preRollSeconds: Math.max(0, coreStartSeconds - cutStartSeconds),
    postRollSeconds: Math.max(0, cutEndSeconds - coreEndSeconds)
  };
}

function getMomentMetrics(moment, report) {
  if (moment.metrics?.radarScore !== undefined) {
    return {
      durationMinutes: getDurationMinutes(moment),
      chatPerMinute: moment.metrics.chatPerMinute || 0,
      chatSpike: moment.metrics.chatSpike || 0,
      chatScore: moment.metrics.chatScore || 0,
      clipDensityPerHour: moment.metrics.clipDensityPerHour || 0,
      clipDensitySpike: moment.metrics.clipDensitySpike || 0,
      clipDensityScore: moment.metrics.clipDensityScore || 0,
      clipReachScore: moment.metrics.clipReachScore || 0,
      clipImpact: moment.metrics.clipImpact || 0,
      keywordPerMinute: moment.metrics.keywordPerMinute || 0,
      keywordSpike: moment.metrics.keywordSpike || 0,
      keywordScore: moment.metrics.keywordScore || 0,
      radarScore: moment.metrics.radarScore || 0
    };
  }

  const baseline = report.analysis?.baseline || {};
  const moments = report.moments || [];
  const durationMinutes = getDurationMinutes(moment);
  const maxClipViews = Math.max(...moments.map((item) => item.clipViews || 0), 1);
  const baselineChat = Math.max(baseline.chatPerMinute || 1, 0.1);
  const baselineKeywords = Math.max(baseline.keywordHitsPerMinute || 1, 0.1);
  const baselineClips = Math.max(baseline.clipCountPerHour || 1, 0.1);

  const chatPerMinute = (moment.chat || 0) / durationMinutes;
  const chatSpike = chatPerMinute / baselineChat;
  const chatScore = scaleSpike(chatSpike, 8);

  const clipDensityPerHour = ((moment.clips || 0) / durationMinutes) * 60;
  const clipDensitySpike = clipDensityPerHour / baselineClips;
  const clipDensityScore = hasClipData(report) ? scaleSpike(clipDensitySpike, 10) : 0;
  const clipReachScore = hasClipData(report)
    ? (Math.log10((moment.clipViews || 0) + 1) / Math.log10(maxClipViews + 1)) * 100
    : 0;
  const clipImpact = clipReachScore * 0.6 + clipDensityScore * 0.4;

  const keywordPerMinute = (moment.keywordHits || moment.keywords?.length || 0) / durationMinutes;
  const keywordSpike = keywordPerMinute / baselineKeywords;
  const keywordScore = scaleSpike(keywordSpike, 8);

  const weights = hasClipData(report) ? SCORE_WEIGHTS.full : SCORE_WEIGHTS.chatOnly;
  const radarScore = hasClipData(report)
    ? chatScore * weights.chatSpike +
      clipReachScore * weights.clipReach +
      clipDensityScore * weights.clipDensity +
      keywordScore * weights.keywordSpike
    : chatScore * weights.chatSpike + keywordScore * weights.keywordSpike;

  return {
    durationMinutes,
    chatPerMinute,
    chatSpike,
    chatScore,
    clipDensityPerHour,
    clipDensitySpike,
    clipDensityScore,
    clipReachScore,
    clipImpact,
    keywordPerMinute,
    keywordSpike,
    keywordScore,
    radarScore: Math.round(radarScore * 10) / 10
  };
}

function getSortedMoments(report) {
  const review = getReviewState(report);
  return [...(report.moments || [])]
    .filter((moment) => review.showExcluded || !review.excluded.has(moment.id))
    .sort((a, b) => {
      const aPinned = review.pinned.has(a.id) ? 1 : 0;
      const bPinned = review.pinned.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aExcluded = review.excluded.has(a.id) ? 1 : 0;
      const bExcluded = review.excluded.has(b.id) ? 1 : 0;
      if (aExcluded !== bExcluded) return aExcluded - bExcluded;
      const aMetrics = getMomentMetrics(a, report);
      const bMetrics = getMomentMetrics(b, report);
      if (state.sortBy === "chat") return bMetrics.chatSpike - aMetrics.chatSpike;
      if (state.sortBy === "clips") return bMetrics.clipImpact - aMetrics.clipImpact;
      return bMetrics.radarScore - aMetrics.radarScore;
    });
}

function getTimelineMoments(report, moments) {
  if (!isWeeklyReport(report) || state.timelineVideoId === "all") return moments;
  return moments.filter((moment) => moment.videoId === state.timelineVideoId);
}

function getVodSummaries(report, moments) {
  if (report.analysis?.vodSummaries?.length) return report.analysis.vodSummaries;
  return getReportVideos(report).map((video) => {
    const videoMoments = moments.filter((moment) => moment.videoId === video.id);
    const topMoment = videoMoments[0] || {};
    return {
      videoId: video.id,
      title: video.title,
      publishDate: video.publishDate,
      chatCount: videoMoments.reduce((sum, moment) => sum + (moment.chat || 0), 0),
      candidateCount: videoMoments.length,
      confidenceScore: 0,
      topScore: topMoment.metrics?.radarScore || 0,
      topMomentTitle: topMoment.title || "",
      topMomentStart: topMoment.start || ""
    };
  });
}

function getConfidenceScore(report) {
  if (report.analysis?.confidenceScore !== undefined) {
    return report.analysis.confidenceScore;
  }
  const moments = report.moments || [];
  if (!moments.length) return 0;
  const signalScores = moments.map((moment) => {
    const item = getMomentMetrics(moment, report);
    const chatSignal = item.chatSpike >= 2 ? 1 : item.chatSpike >= 1.4 ? 0.65 : 0.25;
    const clipSignal = hasClipData(report)
      ? item.clipDensitySpike >= 2 || item.clipReachScore >= 70
        ? 1
        : item.clipDensitySpike >= 1.3 || item.clipReachScore >= 45
          ? 0.65
          : 0.25
      : 0.45;
    const keywordSignal = item.keywordSpike >= 2 ? 1 : item.keywordSpike >= 1.4 ? 0.65 : 0.25;
    return (chatSignal + clipSignal + keywordSignal) / 3;
  });
  return Math.round(
    signalScores.reduce((sum, score) => sum + score, 0) / signalScores.length * 100
  );
}

function getStreamerInitial(name) {
  return String(name || "C").trim().slice(0, 1).toUpperCase() || "C";
}

function renderStreamerStrip(report) {
  const streamer = report.streamer || {};
  const image = $("#streamerAvatarImage");
  const fallback = $("#streamerAvatarFallback");
  const profileImageUrl = streamer.profileImageUrl || "";

  fallback.textContent = getStreamerInitial(streamer.name);
  image.alt = `${streamer.name || "스트리머"} 프로필 이미지`;
  image.style.display = profileImageUrl ? "block" : "none";
  fallback.style.display = profileImageUrl ? "none" : "grid";
  if (profileImageUrl && image.src !== profileImageUrl) {
    image.src = profileImageUrl;
  }
  image.onerror = () => {
    image.style.display = "none";
    fallback.style.display = "grid";
  };

  $("#streamerName").textContent = `${streamer.name || "ClipRadar"}${streamer.verified ? " · 인증 채널" : ""}`;
  $("#streamerReportTitle").textContent = getReportTitle(report);
}

function renderControls() {
  const reportSelect = $("#streamerSelect");
  reportSelect.innerHTML = "";
  state.reports.forEach((report, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${report.streamer.name} - ${getReportTitle(report)}`;
    reportSelect.appendChild(option);
  });
  reportSelect.value = String(state.activeReportIndex);
  $("#sortSelect").value = state.sortBy;
  $("#analysisModeSelect").value = state.analysisMode;
  const review = getReviewCounts(getActiveReport());
  const excludedButton = $("#toggleExcludedButton");
  excludedButton.textContent = review.showExcluded
    ? `제외 숨기기 (${review.excluded})`
    : `제외 보기 (${review.excluded})`;
}

function renderSummary(report, moments) {
  $("#confidenceScore").textContent = `${getConfidenceScore(report)}%`;
  const baseline = report.analysis?.baseline || {};
  const modeText = hasClipData(report) ? "채팅+클립" : "채팅 기반";
  const isSampled = (report.source?.dataMode || "").includes("sampled");
  const videoCount = getReportVideoCount(report);
  const reviewCounts = getReviewCounts(report);
  const candidateHelper =
    report.analysis?.rawCandidateCount && report.analysis?.mergedCandidateCount
      ? `병합 ${formatNumber(report.analysis.rawCandidateCount)}개 -> ${formatNumber(report.analysis.mergedCandidateCount)}개`
      : `후보 ${formatNumber(report.analysis?.candidateCount || moments.length)}개`;
  const reviewHelper = `고정 ${reviewCounts.pinned}개 · 제외 ${reviewCounts.excluded}개`;
  const summary = [
    ["분석 모드", modeText, report.source?.dataMode || "sample"],
    ["분석 VOD", `${formatNumber(videoCount)}개`, getReportTitle(report)],
    [isSampled ? "샘플 채팅" : "수집 채팅", `${formatNumber(report.analysis?.chatCount)}개`, `${report.analysis?.bucketSeconds || 30}초 단위 분석`],
    ["평균 채팅", `${formatDecimal(baseline.chatPerMinute)}/분`, `${candidateHelper} · ${reviewHelper}`]
  ];

  const grid = $("#summaryGrid");
  const template = $("#summaryTemplate");
  grid.innerHTML = "";
  summary.forEach(([label, value, helper]) => {
    const node = template.content.cloneNode(true);
    node.querySelector("span").textContent = label;
    node.querySelector("strong").textContent = value;
    node.querySelector("small").textContent = helper;
    grid.appendChild(node);
  });
}

function renderTimelineTabs(report) {
  const tabs = $("#timelineTabs");
  tabs.innerHTML = "";
  if (!isWeeklyReport(report)) {
    tabs.style.display = "none";
    state.timelineVideoId = "all";
    return;
  }

  const videos = getReportVideos(report);
  const validIds = new Set(["all", ...videos.map((video) => video.id)]);
  if (!validIds.has(state.timelineVideoId)) state.timelineVideoId = "all";
  tabs.style.display = "flex";

  const tabItems = [
    { id: "all", label: "전체 요약" },
    ...videos.map((video, index) => ({
      id: video.id,
      label: getVideoTabLabel(video, index)
    }))
  ];

  tabItems.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-tab${state.timelineVideoId === item.id ? " active" : ""}`;
    button.textContent = item.label;
    button.addEventListener("click", () => {
      state.timelineVideoId = item.id;
      render();
    });
    tabs.appendChild(button);
  });
}

function renderWeeklyOverview(report, moments) {
  const overview = $("#weeklyOverview");
  overview.innerHTML = "";
  if (!isWeeklyReport(report) || state.timelineVideoId !== "all") {
    overview.style.display = "none";
    return;
  }

  overview.style.display = "grid";
  const summaries = getVodSummaries(report, moments);
  const maxScore = Math.max(...summaries.map((summary) => summary.topScore || 0), 1);

  summaries.forEach((summary, index) => {
    const card = document.createElement("article");
    card.className = "weekly-vod-card";
    const score = summary.topScore || 0;
    const candidateStat =
      summary.rawCandidateCount && summary.mergedCandidateCount
        ? `<span>병합<b>${formatNumber(summary.rawCandidateCount)}→${formatNumber(summary.mergedCandidateCount)}</b></span>`
        : `<span>후보<b>${formatNumber(summary.candidateCount)}개</b></span>`;
    card.innerHTML = `
      <strong>${getVideoTabLabel(summary, index)} · ${summary.title || `VOD ${index + 1}`}</strong>
      <p>${summary.topMomentTitle ? `대표 구간 ${summary.topMomentStart || ""} · ${summary.topMomentTitle}` : "대표 구간을 찾는 중입니다."}</p>
      <div class="weekly-vod-stats">
        ${candidateStat}
        <span>샘플 채팅<b>${formatNumber(summary.chatCount)}개</b></span>
        <span>최고 점수<b>${formatDecimal(score)}</b></span>
      </div>
      <div class="weekly-score-bar"><span style="width: ${clamp((score / maxScore) * 100, 4, 100)}%"></span></div>
    `;
    overview.appendChild(card);
  });
}

function renderMomentMap(report, moments) {
  renderTimelineTabs(report);
  renderWeeklyOverview(report, moments);

  const eyebrow = $("#momentMapEyebrow");
  const title = $("#momentMapTitle");
  const description = $("#momentMapDescription");
  const timeline = $("#timeline");
  const filteredMoments = getTimelineMoments(report, moments);

  if (isWeeklyReport(report) && state.timelineVideoId === "all") {
    eyebrow.textContent = "Weekly Overview";
    title.textContent = "주간 방송별 반응 요약";
    description.textContent = "여러 방송을 하나의 타임라인에 억지로 섞지 않고, 방송별 후보 수와 대표 구간을 먼저 비교합니다. 개별 VOD 탭을 누르면 해당 방송 안에서만 타임라인을 봅니다.";
    timeline.style.display = "none";
    timeline.innerHTML = "";
    return filteredMoments;
  }

  if (isWeeklyReport(report)) {
    eyebrow.textContent = "VOD Timeline";
    title.textContent = "선택한 방송의 타임라인";
    description.textContent = "선택한 VOD 안에서만 채팅 급증 구간을 표시합니다. 다른 방송의 같은 시각과 섞이지 않도록 분리해서 보여줍니다.";
  } else {
    eyebrow.textContent = "Moment Map";
    title.textContent = "VOD 타임라인 신호";
    description.textContent = "채팅 폭발, 클립 생성, 키워드 급증이 겹치는 구간일수록 더 밝게 표시됩니다.";
  }
  timeline.style.display = "grid";
  renderTimeline(report, filteredMoments);
  return filteredMoments;
}

function renderTimeline(report, moments) {
  const timeline = $("#timeline");
  timeline.innerHTML = "";
  if (!moments.length) {
    timeline.innerHTML = "<p class=\"empty-state\">하이라이트 후보가 없습니다.</p>";
    return;
  }
  const maxScore = Math.max(...moments.map((moment) => getMomentMetrics(moment, report).radarScore), 1);
  moments.forEach((moment) => {
    const metrics = getMomentMetrics(moment, report);
    const row = document.createElement("div");
    row.className = "timeline-row";
    const startSeconds = moment.startTimeSeconds ?? parseTimeToSeconds(moment.start);
    const score = metrics.radarScore;
    const hotStart = Math.min(44, Math.floor((startSeconds % 14400) / 300));
    const hotWidth = Math.max(2, Math.round((score / maxScore) * 7));
    row.innerHTML = `
      <div class="timeline-label">${moment.watchAt || formatSeconds(startSeconds)}</div>
      <div class="timeline-track"></div>
      <div class="timeline-score">${score}</div>
    `;
    const track = row.querySelector(".timeline-track");
    for (let i = 0; i < 48; i += 1) {
      const tick = document.createElement("span");
      tick.className = i >= hotStart && i <= hotStart + hotWidth ? "tick hot" : "tick";
      track.appendChild(tick);
    }
    timeline.appendChild(row);
  });
}

function renderMoments(report, moments) {
  const container = $("#moments");
  const template = $("#momentTemplate");
  container.innerHTML = "";
  moments.forEach((moment, index) => {
    const metrics = getMomentMetrics(moment, report);
    const ranges = getMomentRanges(moment);
    const highlightType = getHighlightType(moment);
    const reviewStatus = getMomentReviewStatus(report, moment);
    const node = template.content.cloneNode(true);
    const start = ranges.coreStart;
    const end = ranges.coreEnd;
    const card = node.querySelector(".moment-card");
    card.classList.toggle("pinned", reviewStatus === "pinned");
    card.classList.toggle("excluded", reviewStatus === "excluded");
    node.querySelector(".rank").textContent = `#${index + 1}`;
    node.querySelector(".badge").textContent = `점수 ${metrics.radarScore}`;
    node.querySelector(".time").textContent = `${start} - ${end}`;
    node.querySelector("h3").textContent = moment.title;
    node.querySelector(".reason").textContent = moment.reason || "채팅/키워드 반응이 평균보다 높게 나타난 구간입니다.";
    const watchLink = node.querySelector("a");
    watchLink.href = buildTimedChzzkUrl(
      moment.url || moment.videoUrl || report.video.url,
      ranges.coreStartTimeSeconds
    );
    watchLink.title = `치지직에서 ${ranges.coreStart} 시점 열기`;

    const metricsEl = node.querySelector(".metrics");
    const metricItems = [
      getReportVideoCount(report) > 1 ? `VOD ${moment.videoTitle || moment.vodTitle || "알 수 없음"}` : null,
      reviewStatus === "pinned" ? "고정됨" : null,
      reviewStatus === "excluded" ? "제외됨" : null,
      moment.mergedSegmentCount > 1 ? `병합 ${moment.mergedSegmentCount}개 구간` : null,
      `타입 ${highlightType.label} ${getTypeConfidence(moment)}%`,
      `핵심 반응 ${ranges.coreStart}~${ranges.coreEnd}`,
      `추천 컷 ${ranges.cutStart}~${ranges.cutEnd}`,
      `프리롤 ${ranges.preRollSeconds}초`,
      `포스트롤 ${ranges.postRollSeconds}초`,
      `채팅 급증 ${formatDecimal(metrics.chatSpike)}배`,
      `채팅 ${formatNumber(moment.chat)}개`,
      hasClipData(report) ? `클립 밀도 ${formatDecimal(metrics.clipDensityPerHour)}개/시간` : "클립 데이터 없음",
      hasClipData(report) ? `클립 조회 영향 ${formatDecimal(metrics.clipReachScore, 0)}` : "채팅 기반 분석",
      `키워드 급증 ${formatDecimal(metrics.keywordSpike)}배`,
      `시청 링크 ${moment.watchAt || start}`
    ].filter(Boolean);
    metricItems.forEach((metric) => {
      const pill = document.createElement("span");
      pill.textContent = metric;
      metricsEl.appendChild(pill);
    });

    const keywords = node.querySelector(".keywords");
    (moment.keywords || []).forEach((keyword) => {
      const pill = document.createElement("span");
      pill.textContent = `#${keyword}`;
      keywords.appendChild(pill);
    });

    const evidenceEl = node.querySelector(".evidence-keywords");
    getEvidenceKeywords(moment).forEach((item) => {
      const pill = document.createElement("span");
      pill.textContent = `${item.keyword} ${formatNumber(item.count)}회`;
      evidenceEl.appendChild(pill);
    });

    const chatSamples = node.querySelector(".chat-samples");
    getRepresentativeChats(moment).forEach((sample) => {
      const item = document.createElement("blockquote");
      item.innerHTML = `<time>${sample.time || start}</time><span>${escapeHtml(sample.message || "")}</span>`;
      chatSamples.appendChild(item);
    });

    const pinButton = node.querySelector(".pin-button");
    pinButton.textContent = reviewStatus === "pinned" ? "고정 해제" : "고정";
    pinButton.addEventListener("click", () => togglePinned(report, moment));

    const excludeButton = node.querySelector(".exclude-button");
    excludeButton.textContent = reviewStatus === "excluded" ? "제외 취소" : "제외";
    excludeButton.addEventListener("click", () => toggleExcluded(report, moment));

    container.appendChild(node);
  });
}

function buildReportPayload(report, moments = getSortedMoments(report), options = {}) {
  const review = getReviewState(report);
  const includeExcluded = Boolean(options.includeExcluded);
  const exportMoments = moments.filter((moment) => includeExcluded || !review.excluded.has(moment.id));
  return {
    ...report,
    exportTarget: options.target || "clipradar",
    exportedAt: new Date().toISOString(),
    review: {
      pinnedIds: [...review.pinned],
      excludedIds: [...review.excluded],
      excludedOmitted: !includeExcluded
    },
    moments: exportMoments.map((moment, index) => {
      const highlightType = getHighlightType(moment);
      const reviewStatus = getMomentReviewStatus(report, moment);
      return {
        ...moment,
        ...getMomentRanges(moment),
        highlightType: highlightType.type,
        highlightTypeLabel: highlightType.label,
        highlightTypeConfidence: getTypeConfidence(moment),
        evidenceKeywords: getEvidenceKeywords(moment),
        representativeChats: getRepresentativeChats(moment),
        reviewStatus,
        reviewStatusLabel: formatReviewStatus(reviewStatus),
        rank: index + 1,
        metrics: getMomentMetrics(moment, report),
        url: moment.url || report.video.url
      };
    })
  };
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value) {
  return String(value || "clipradar").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
}

function exportClipCatcherJson() {
  const report = getActiveReport();
  downloadBlob(
    `${safeFileName(report.streamer.name)}-clipcatcher-import.json`,
    JSON.stringify(buildReportPayload(report, getSortedMoments(report), { target: "clipcatcher" }), null, 2),
    "application/json"
  );
}

function exportCsv() {
  const report = buildReportPayload(getActiveReport());
  const rows = [
    ["순위", "상태", "VOD", "타입", "타입 신뢰도", "근거 키워드", "대표 채팅", "병합 수", "핵심 시작", "핵심 종료", "추천 컷 시작", "추천 컷 종료", "프리롤", "포스트롤", "제목", "점수", "채팅 급증", "키워드 급증", "선정 이유", "VOD URL"]
  ];
  report.moments.forEach((moment) => {
    rows.push([
      moment.rank,
      moment.reviewStatusLabel || formatReviewStatus(moment.reviewStatus),
      moment.videoTitle || moment.vodTitle || report.video.title,
      moment.highlightTypeLabel || "채팅 급증",
      `${moment.highlightTypeConfidence || 50}%`,
      getEvidenceKeywords(moment).map((item) => `${item.keyword} ${item.count}회`).join(" / "),
      getRepresentativeChats(moment).map((sample) => `[${sample.time}] ${sample.message}`).join(" / "),
      moment.mergedSegmentCount || 1,
      moment.coreStart || moment.start || formatSeconds(moment.startTimeSeconds),
      moment.coreEnd || moment.end || formatSeconds(moment.endTimeSeconds),
      moment.cutStart || moment.coreStart || moment.start || formatSeconds(moment.startTimeSeconds),
      moment.cutEnd || moment.coreEnd || moment.end || formatSeconds(moment.endTimeSeconds),
      `${moment.preRollSeconds || 0}초`,
      `${moment.postRollSeconds || 0}초`,
      moment.title,
      moment.metrics.radarScore,
      `${formatDecimal(moment.metrics.chatSpike)}배`,
      `${formatDecimal(moment.metrics.keywordSpike)}배`,
      moment.reason || "",
      moment.url || moment.videoUrl || report.video.url
    ]);
  });
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(","))
    .join("\n");
  downloadBlob(`${safeFileName(report.streamer.name)}-editor-table.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
}

function reportToHtml(report, mode = "editor") {
  const title = mode === "weekly" ? "주간 하이라이트 리포트" : "편집자 작업표";
  const rows = report.moments.map((moment) => `
    <tr>
      <td>${moment.rank}</td>
      <td>${escapeHtml(moment.reviewStatusLabel || formatReviewStatus(moment.reviewStatus))}</td>
      <td>${escapeHtml(moment.videoTitle || moment.vodTitle || report.video.title)}</td>
      <td>${escapeHtml(moment.highlightTypeLabel || "채팅 급증")} ${moment.highlightTypeConfidence || 50}%</td>
      <td>${escapeHtml(getEvidenceKeywords(moment).map((item) => `${item.keyword} ${item.count}회`).join(" / "))}</td>
      <td>${escapeHtml(getRepresentativeChats(moment).map((sample) => `[${sample.time}] ${sample.message}`).join(" / "))}</td>
      <td>${moment.mergedSegmentCount || 1}</td>
      <td>${moment.coreStart || moment.start || formatSeconds(moment.startTimeSeconds)} - ${moment.coreEnd || moment.end || formatSeconds(moment.endTimeSeconds)}</td>
      <td>${moment.cutStart || moment.start || formatSeconds(moment.startTimeSeconds)} - ${moment.cutEnd || moment.end || formatSeconds(moment.endTimeSeconds)}</td>
      <td>${escapeHtml(moment.title)}</td>
      <td>${moment.metrics.radarScore}</td>
      <td>${escapeHtml(moment.reason || "")}</td>
    </tr>
  `).join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.streamer.name)} ${title}</title>
  <style>
    body { margin: 0; padding: 36px; color: #172016; background: #f7f9ef; font-family: Apple SD Gothic Neo, Pretendard, sans-serif; }
    h1 { font-size: 38px; letter-spacing: -0.04em; }
    .meta { color: #66715d; line-height: 1.7; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; background: white; }
    th, td { border-bottom: 1px solid #dfe6d8; padding: 12px; text-align: left; vertical-align: top; }
    th { background: #172016; color: #c6ff3d; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 24px; }
    .card { background: white; border: 1px solid #dfe6d8; border-radius: 18px; padding: 18px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(report.streamer.name)} ${title}</h1>
	  <p class="meta">${escapeHtml(getReportTitle(report))}<br />신뢰도 ${report.analysis.confidenceScore}% · ${report.analysis.scoringModel.radarScore}</p>
	  ${mode === "weekly" ? `
	    <section class="cards">
	      ${report.moments.map((moment) => `<article class="card"><strong>#${moment.rank} ${escapeHtml(moment.title)}</strong><p>${escapeHtml(moment.videoTitle || moment.vodTitle || report.video.title)}</p><p>타입 ${escapeHtml(moment.highlightTypeLabel || "채팅 급증")} ${moment.highlightTypeConfidence || 50}% · 병합 ${moment.mergedSegmentCount || 1}개 구간</p><p>추천 컷 ${moment.cutStart || moment.start || formatSeconds(moment.startTimeSeconds)} - ${moment.cutEnd || moment.end || formatSeconds(moment.endTimeSeconds)}</p><p>${escapeHtml(getEvidenceKeywords(moment).map((item) => `${item.keyword} ${item.count}회`).join(" / "))}</p><p>${escapeHtml(moment.reason || "")}</p></article>`).join("")}
	    </section>
	  ` : ""}
	  <table>
	    <thead><tr><th>순위</th><th>상태</th><th>VOD</th><th>타입</th><th>근거 키워드</th><th>대표 채팅</th><th>병합 수</th><th>핵심 반응</th><th>추천 컷</th><th>제목</th><th>점수</th><th>선정 이유</th></tr></thead>
	    <tbody>${rows}</tbody>
	  </table>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function exportHtml(mode) {
  const report = buildReportPayload(getActiveReport());
  const suffix = mode === "weekly" ? "weekly-report" : "editor-table";
  downloadBlob(
    `${safeFileName(report.streamer.name)}-${suffix}.html`,
    reportToHtml(report, mode),
    "text/html;charset=utf-8"
  );
}

async function analyzeVod() {
  const urls = getInputUrls();
  if (!urls.length) {
    $("#analyzeStatus").textContent = "VOD URL을 입력해주세요.";
    return;
  }
  const mode = state.analysisMode;
  const modeLabel = mode === "precise" ? "정밀 분석" : "빠른 분석";
  $("#analyzeButton").disabled = true;
  $("#analyzeStatus").textContent =
    urls.length > 1
      ? `${urls.length}개 VOD를 주간 묶음으로 ${modeLabel}하는 중입니다...`
      : `VOD 전체를 ${modeLabel}으로 샘플링해 채팅 반응 구간을 찾는 중입니다...`;
  try {
    const isWeekly = urls.length > 1;
    const samplePages = mode === "precise"
      ? isWeekly ? 72 : 96
      : isWeekly ? 24 : 36;
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls,
        bucketSeconds: 30,
        topN: isWeekly ? 20 : 12,
        scanMode: mode,
        samplePages
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "분석 실패");
    state.reports.unshift(payload);
    state.activeReportIndex = 0;
    state.timelineVideoId = "all";
    const chatLabel = (payload.source?.dataMode || "").includes("sampled") ? "샘플 채팅" : "채팅";
    const vodLabel = getReportVideoCount(payload) > 1 ? `VOD ${getReportVideoCount(payload)}개, ` : "";
    $("#analyzeStatus").textContent = `분석 완료: ${vodLabel}${chatLabel} ${formatNumber(payload.analysis.chatCount)}개, 후보 ${payload.moments.length}개`;
    render();
  } catch (error) {
    $("#analyzeStatus").textContent = `오류: ${error.message}`;
  } finally {
    $("#analyzeButton").disabled = false;
  }
}

function render() {
  const report = getActiveReport();
  const moments = getSortedMoments(report);
  renderControls();
  renderStreamerStrip(report);
  renderSummary(report, moments);
  const visibleMoments = renderMomentMap(report, moments);
  renderMoments(report, visibleMoments);
}

$("#streamerSelect").addEventListener("change", (event) => {
  state.activeReportIndex = Number(event.target.value);
  state.timelineVideoId = "all";
  render();
});

$("#sortSelect").addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  render();
});

$("#analysisModeSelect").addEventListener("change", (event) => {
  state.analysisMode = event.target.value;
  renderControls();
});

$("#analyzeButton").addEventListener("click", analyzeVod);
$("#exportClipCatcherJsonButton").addEventListener("click", exportClipCatcherJson);
$("#exportCsvButton").addEventListener("click", exportCsv);
$("#exportEditorHtmlButton").addEventListener("click", () => exportHtml("editor"));
$("#exportWeeklyHtmlButton").addEventListener("click", () => exportHtml("weekly"));
$("#toggleExcludedButton").addEventListener("click", toggleExcludedVisibility);

render();
