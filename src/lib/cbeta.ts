import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Converter } from "opencc-js";
import { CbetaCatalogItem, SutraSection, SutraWork, TextBlock } from "../types";

const cacheDirectory = `${FileSystem.documentDirectory ?? ""}cbeta-cache`;
const convertToSimplified = Converter({ from: "tw", to: "cn" });
const toSimplified = (text: string) =>
  normalizeResidualDisplayGlyphs(convertToSimplifiedSafely(normalizeDisplayGlyphs(text)));
const convertToSimplifiedSafely = (text: string) => {
  const converted = convertToSimplified(text);
  const sourceChars = Array.from(text);
  const convertedChars = Array.from(converted);

  if (sourceChars.length !== convertedChars.length) {
    return converted;
  }

  return convertedChars
    .map((char, index) =>
      containsDisplayRiskGlyph(char) && !containsDisplayRiskGlyph(sourceChars[index])
        ? sourceChars[index]
        : char,
    )
    .join("");
};
const normalizeDisplayGlyphs = (text: string) =>
  text.replace(/CBETA CHARACTER CB\d+[a-z]?/g, "□");
const normalizeResidualDisplayGlyphs = (text: string) =>
  text.replace(/[\uE000-\uF8FF\u{20000}-\u{3FFFF}\u{F0000}-\u{10FFFF}]/gu, "□");
const preferredSourceKey = "sutrareader.cbetaPreferredSource.v1";
const sourceTimeoutMs = 8000;
const apiHtmlMaxJuans = 40;
const cbetaParserVersion = 25;
const cbetaApiBases = [
  "https://cbdata.dila.edu.tw/stable",
  "https://api.cbetaonline.cn/stable",
] as const;
const cbetaSourceTemplates = [
  {
    id: "github",
    url: "https://raw.githubusercontent.com/cbeta-org/xml-p5/master/{path}",
  },
  {
    id: "jsdelivr",
    url: "https://cdn.jsdelivr.net/gh/cbeta-org/xml-p5@master/{path}",
  },
  {
    id: "staticdelivr",
    url: "https://cdn.staticdelivr.com/gh/cbeta-org/xml-p5/master/{path}",
  },
  {
    id: "githubraw",
    url: "https://cdn.githubraw.com/cbeta-org/xml-p5/master/{path}",
  },
  {
    id: "gh-proxy",
    url: "https://gh-proxy.com/https://raw.githubusercontent.com/cbeta-org/xml-p5/master/{path}",
  },
] as const;

const ensureCacheDirectory = async () => {
  const info = await FileSystem.getInfoAsync(cacheDirectory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(cacheDirectory, { intermediates: true });
  }
};

const cachePathFor = (item: CbetaCatalogItem) =>
  `${cacheDirectory}/${item.path.replace(/\//g, "__")}.json`;

export const isCbetaWorkCached = async (item: CbetaCatalogItem) => {
  await ensureCacheDirectory();
  return FileSystem.getInfoAsync(cachePathFor(item)).then((info) => info.exists);
};

export const loadCbetaWork = async (item: CbetaCatalogItem): Promise<SutraWork> => {
  await ensureCacheDirectory();
  const cachePath = cachePathFor(item);
  const cached = await FileSystem.getInfoAsync(cachePath);

  if (cached.exists) {
    const work = JSON.parse(await FileSystem.readAsStringAsync(cachePath)) as SutraWork;
    if (shouldRefreshCachedWork(work, item)) {
      await FileSystem.deleteAsync(cachePath, { idempotent: true });
    } else {
      const normalized = normalizeCachedWork(work);
      if (normalized.changed) {
        await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(normalized.work));
      }
      return normalized.work;
    }
  }

  const work = await fetchCbetaApiHtmlWork(item).catch(async () => {
    const xml = await fetchCbetaXml(item);
    return parseCbetaXml(item, xml);
  });
  await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(work));
  return work;
};

type CbetaWorkInfo = {
  title?: string;
  byline?: string;
  juan?: number;
  juan_list?: string;
};

type CbetaWorksResponse = {
  num_found?: number;
  results?: CbetaWorkInfo[];
};

type CbetaJuanResponse = {
  num_found?: number;
  results?: string[];
};

const fetchCbetaApiHtmlWork = async (item: CbetaCatalogItem): Promise<SutraWork> => {
  const apiWorkId = apiWorkIdFor(item);
  const workInfoResponse = await fetchCbetaApiJson<CbetaWorksResponse>(
    `works?work=${encodeURIComponent(apiWorkId)}`,
  );
  const workInfo = workInfoResponse.results?.[0];
  const juans = parseJuanList(workInfo?.juan_list, workInfo?.juan);

  if (!workInfo || !juans.length || juans.length > apiHtmlMaxJuans) {
    throw new Error("CBETA API source skipped for this work");
  }

  const htmlByJuan = await fetchCbetaApiJuans(apiWorkId, juans);
  return parseCbetaApiHtml(item, workInfo, htmlByJuan);
};

const fetchCbetaApiJuans = async (apiWorkId: string, juans: number[]) => {
  const firstJuan = juans[0];
  const lastJuan = juans[juans.length - 1];
  const juanParam =
    firstJuan === lastJuan ? String(firstJuan) : `${firstJuan}-${lastJuan}`;
  const response = await fetchCbetaApiJson<CbetaJuanResponse>(
    `juans?work=${encodeURIComponent(apiWorkId)}&juan=${encodeURIComponent(juanParam)}`,
  );
  const html = response.results?.[0];
  if (!html) {
    throw new Error(`CBETA API returned no content for ${apiWorkId} 卷 ${juanParam}`);
  }

  return [{ juan: firstJuan, html }];
};

const fetchCbetaApiJson = async <T,>(path: string): Promise<T> => {
  const controllers = cbetaApiBases.map(() => new AbortController());
  try {
    const { text } = await promiseAny(
      cbetaApiBases.map(async (base, index) => {
        const text = await fetchTextWithTimeout(
          `${base}/${path}`,
          sourceTimeoutMs,
          controllers[index].signal,
        );
        if (!text.trim().startsWith("{")) {
          throw new Error("返回的内容不是有效的 CBETA API JSON");
        }
        return { text };
      }),
    );
    return JSON.parse(text) as T;
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
};

const apiWorkIdFor = (item: CbetaCatalogItem) =>
  `${item.canon}${item.number.toUpperCase()}`;

const parseJuanList = (juanList: string | undefined, juanCount: number | undefined) => {
  const fromList =
    juanList
      ?.split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isFinite(item)) ?? [];

  if (fromList.length) {
    return fromList;
  }

  if (juanCount && Number.isFinite(juanCount)) {
    return Array.from({ length: juanCount }, (_item, index) => index + 1);
  }

  return [];
};

const fetchCbetaXml = async (item: CbetaCatalogItem) => {
  const preferredSource = await AsyncStorage.getItem(preferredSourceKey);
  const sourceBatches = sourceRaceBatches(preferredSource);
  let lastError: unknown;

  for (const sources of sourceBatches) {
    try {
      const winner = await raceCbetaSources(item.path, sources);
      await AsyncStorage.setItem(preferredSourceKey, winner.source.id);
      return winner.xml;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `无法从 CBETA 下载 ${item.sourceId}：${lastError.message}`
      : `无法从 CBETA 下载 ${item.sourceId}`,
  );
};

const sourceRaceBatches = (preferredSource: string | null) => {
  const preferred = cbetaSourceTemplates.find((source) => source.id === preferredSource);
  const fastSourceIds = new Set(["github", "jsdelivr", "staticdelivr"]);
  const firstBatch = [
    ...(preferred ? [preferred] : []),
    ...cbetaSourceTemplates.filter(
      (source) => fastSourceIds.has(source.id) && source.id !== preferred?.id,
    ),
  ];
  const secondBatch = cbetaSourceTemplates.filter(
    (source) => !firstBatch.some((candidate) => candidate.id === source.id),
  );

  return [firstBatch, secondBatch].filter((batch) => batch.length > 0);
};

type CbetaSourceTemplate = (typeof cbetaSourceTemplates)[number];

const raceCbetaSources = async (path: string, sources: CbetaSourceTemplate[]) => {
  const controllers = sources.map(() => new AbortController());
  try {
    return await promiseAny(
      sources.map(async (source, index) => {
        const url = source.url.replace("{path}", path);
        const xml = await fetchTextWithTimeout(
          url,
          sourceTimeoutMs,
          controllers[index].signal,
        );
        if (!looksLikeCbetaXml(xml)) {
          throw new Error("返回的内容不是有效的 CBETA XML");
        }
        return { source, xml };
      }),
    );
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
};

const fetchTextWithTimeout = async (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal.aborted) {
    abort();
  }
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};

const promiseAny = async <T,>(promises: Promise<T>[]) =>
  new Promise<T>((resolve, reject) => {
    const errors: unknown[] = [];
    let rejectedCount = 0;

    promises.forEach((promise, index) => {
      promise.then(resolve).catch((error) => {
        errors[index] = error;
        rejectedCount += 1;
        if (rejectedCount === promises.length) {
          reject(errors.find((item) => item instanceof Error) ?? new Error("所有数据源都不可用"));
        }
      });
    });
  });

const looksLikeCbetaXml = (text: string) =>
  text.includes("<TEI") || text.includes("<teiCorpus") || text.includes("<text");

const shouldRefreshCachedWork = (work: SutraWork, item?: CbetaCatalogItem) => {
  if (!work.blocks.length) {
    return true;
  }

  if (work.parserVersion !== cbetaParserVersion) {
    return true;
  }

  const hasUnresolvedGaiji = work.blocks.some(
    (block) =>
      block.textSimplified.includes("�") ||
      block.textSource.includes("�") ||
      block.textSimplified.includes("CBETA CHARACTER") ||
      block.textSource.includes("CBETA CHARACTER"),
  );
  if (hasUnresolvedGaiji) {
    return true;
  }

  const shortBlocks = work.blocks.filter((block) => block.textSimplified.length < 28).length;
  return work.blocks.length > 80 && shortBlocks / work.blocks.length > 0.35;
};

const normalizeCachedWork = (work: SutraWork) => {
  let changed = false;
  const blocks = work.blocks.map((block) => {
    const textSimplified = normalizeChineseText(block.textSimplified);
    const textSource = normalizeChineseText(block.textSource);
    if (textSimplified === block.textSimplified && textSource === block.textSource) {
      return block;
    }

    changed = true;
    return { ...block, textSimplified, textSource };
  });

  return {
    changed,
    work: changed ? { ...work, blocks } : work,
  };
};

const parseCbetaApiHtml = (
  item: CbetaCatalogItem,
  workInfo: CbetaWorkInfo,
  htmlByJuan: { juan: number; html: string }[],
): SutraWork => {
  const sections: SutraSection[] = [];
  const blocks: TextBlock[] = [];
  const readerHtmlParts: string[] = [];
  let currentSection: SutraSection | undefined;

  const ensureSection = (title: string) => {
    if (!currentSection || currentSection.title !== title) {
      currentSection = {
        id: `${item.id}-section-${sections.length}`,
        workId: item.id,
        title: toSimplified(title),
        order: sections.length,
        blockIds: [],
      };
      sections.push(currentSection);
    }

    return currentSection;
  };

  const addBlock = (source: string, sectionTitle: string, anchorId?: string) => {
    const textSource = normalizeChineseText(
      normalizeResidualDisplayGlyphs(normalizeDisplayGlyphs(source)),
    );
    if (!textSource || textSource.length < 2) {
      return;
    }

    const section = ensureSection(sectionTitle);
    const blockId = `${item.id}-block-${blocks.length}`;
    const block: TextBlock = {
      id: blockId,
      workId: item.id,
      sectionId: section.id,
      anchorId: anchorId ?? `${item.id}-${blocks.length}`,
      order: blocks.length,
      textSource,
      textSimplified: toSimplified(textSource),
    };

    blocks.push(block);
    section.blockIds.push(block.id);
  };

  htmlByJuan.forEach(({ juan, html }) => {
    const gaijiMap = extractHtmlGaijiMap(html);
    const fallbackSectionTitle =
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ??
      workInfo.title ??
      item.title;
    let sectionTitle = normalizeChineseText(stripHtml(fallbackSectionTitle, gaijiMap));
    const readableHtml = html.replace(/<div\b[^>]*id=(["'])back\1[\s\S]*$/i, "");
    const blockPattern =
      /<p\b([^>]*)>([\s\S]*?)<\/p>|<div\b([^>]*\bclass=(["'])lg-row\b[^>]*\4[^>]*)>([\s\S]*?)<\/div>/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let lastAnchorId = readableHtml.match(/<span\b[^>]*\bclass=(["'])lb\b[^>]*\1[^>]*\bid=(["'])(.*?)\2/i)?.[3];

    while ((match = blockPattern.exec(readableHtml))) {
      const between = readableHtml.slice(lastIndex, match.index);
      const anchorId = lastCbetaLineId(between) ?? lastAnchorId;
      if (anchorId) {
        lastAnchorId = anchorId;
      }

      const attrs = match[1] ?? match[3] ?? "";
      const body = match[2] ?? match[5] ?? "";
      const className = attrs.match(/\bclass=(["'])(.*?)\1/)?.[2] ?? "";
      const text = stripHtml(body, gaijiMap);

      if (className.includes("head") || className.includes("juan")) {
        sectionTitle = normalizeChineseText(text) || sectionTitle;
        addBlock(text, sectionTitle, anchorId);
      } else if (className.includes("byline")) {
        addBlock(text, sectionTitle, anchorId);
      } else {
        addBlock(text, sectionTitle || `${item.title} 第${juan}卷`, anchorId);
      }

      lastIndex = blockPattern.lastIndex;
    }

    readerHtmlParts.push(extractCbetaApiBody(html));
  });

  if (!blocks.length) {
    throw new Error("CBETA API source produced no readable blocks");
  }

  return {
    id: item.id,
    title: toSimplified(workInfo.title ?? item.title),
    subtitle: [item.canonTitle, item.sourceId, toSimplified(workInfo.byline ?? "")]
      .filter(Boolean)
      .join(" - "),
    parserVersion: cbetaParserVersion,
    sourcePath: item.path,
    sourceUrl: `https://cbdata.dila.edu.tw/stable/juans?work=${apiWorkIdFor(item)}`,
    sourceAttribution:
      "Text source: CBETA API HTML for UI / CBETA XML P5. Please keep CBETA attribution and source availability notes with redistributed text.",
    readerHtml: combineCbetaApiReaderHtml(readerHtmlParts, workInfo.title ?? item.title),
    readerHtmlIsCompleteDocument: true,
    sections: sections.filter((section) => section.blockIds.length > 0),
    blocks,
  };
};

const combineCbetaApiReaderHtml = (bodyParts: string[], title: string) =>
  `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>${escapeHtml(title)}</title>
${cbetaApiReaderStyle()}
</head>
<body>
${bodyParts.join("\n")}
</body>
</html>`;

const extractCbetaApiBody = (html: string) =>
  html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;

const lastCbetaLineId = (html: string) => {
  const pattern = /<span\b[^>]*\bclass=(["'])lb\b[^>]*\1[^>]*\bid=(["'])(.*?)\2/gi;
  let match: RegExpExecArray | null;
  let id: string | undefined;

  while ((match = pattern.exec(html))) {
    id = match[3];
  }

  return id;
};

const cbetaApiReaderStyle = () =>
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>
      html {
        -webkit-text-size-adjust: 100% !important;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        font-size: 24px !important;
        line-height: 1.75 !important;
        padding: 8px 24px 36px !important;
        margin: 0 !important;
      }
      p,
      div,
      span,
      .t,
      .lg-row,
      .lg-cell {
        font-size: 24px !important;
        line-height: 1.75 !important;
      }
      .lb {
        position: relative !important;
        display: inline !important;
        width: 0 !important;
        height: 0 !important;
        overflow: hidden !important;
        color: transparent !important;
        font-size: 0 !important;
        line-height: 0 !important;
      }
      .lineInfo,
      .facsimile,
      .noteAnchor,
      #back,
      #cbeta-copyright {
        display: none !important;
      }
      .reader-selected {
        background: rgba(142, 96, 61, 0.18) !important;
        border-radius: 8px;
      }
      .search-hit {
        background: rgba(142, 96, 61, 0.24) !important;
        border-radius: 4px;
      }
    </style>`;

type HtmlGaiji = {
  normalized?: string;
  composition?: string;
  unicode?: string;
};

const extractHtmlGaijiMap = (html: string) => {
  const map = new Map<string, HtmlGaiji>();
  const pattern = /<span\b([^>]*\bclass=(["'])gaijiInfo\2[^>]*)>([\s\S]*?)<\/span>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const attrs = match[1];
    const id = htmlAttr(attrs, "id");
    if (!id) {
      continue;
    }

    map.set(id, {
      normalized: htmlAttr(attrs, "norm"),
      composition: htmlAttr(attrs, "zzs"),
      unicode: htmlAttr(attrs, "uni_char") ?? stripHtml(match[3]),
    });
  }

  return map;
};

const htmlAttr = (attrs: string, name: string) =>
  attrs.match(new RegExp(`\\b${name}=(["'])(.*?)\\1`))?.[2];

const displayGaiji = (gaiji: HtmlGaiji | undefined, fallback: string) => {
  if (gaiji?.normalized) {
    return gaiji.normalized;
  }

  const visible = normalizeDisplayGlyphs(stripHtml(fallback));
  if (visible && !containsDisplayRiskGlyph(visible)) {
    return visible;
  }

  return gaiji?.composition ?? "□";
};

const containsDisplayRiskGlyph = (text: string) =>
  /[\uE000-\uF8FF\u{20000}-\u{3FFFF}\u{F0000}-\u{10FFFF}]/u.test(text);

const stripHtml = (html: string, gaijiMap = new Map<string, HtmlGaiji>()) =>
  decodeXml(
    html
      .replace(/<div\b[^>]*id=(["'])back\1[\s\S]*?<\/div>/g, "")
      .replace(/<a\b[^>]*class=(["'])noteAnchor\b[^>]*\1[^>]*><\/a>/g, "")
      .replace(/<span\b[^>]*class=(["'])(?:lb|lineInfo)\b[^>]*\1[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<span\b[^>]*class=(["'])pc\1[^>]*>([\s\S]*?)<\/span>/g, "$2")
      .replace(
        /<a\b([^>]*class=(["'])gaijiAnchor\b[^>]*\2[^>]*)>([\s\S]*?)<\/a>/g,
        (_match, attrs: string, _quote: string, content: string) => {
          const ref = attrs.match(/\bhref=(["'])#([^"']+)\1/)?.[2];
          return displayGaiji(ref ? gaijiMap.get(ref) : undefined, content);
        },
      )
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

const decodeXml = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");

const stripTags = (xml: string, gaijiMap = new Map<string, string>()) =>
  decodeXml(
    xml
      .replace(/<note[\s\S]*?<\/note>/g, "")
      .replace(/<app[\s\S]*?<\/app>/g, "")
      .replace(/<cb:mulu\b[\s\S]*?<\/cb:mulu>/g, "")
      .replace(/<choice[\s\S]*?<reg[^>]*>([\s\S]*?)<\/reg>[\s\S]*?<\/choice>/g, "$1")
      .replace(/<g\b([^>]*)>([\s\S]*?)<\/g>/g, (_match, attrs: string, content: string) => {
        const ref = gaijiRef(attrs);
        return ref ? gaijiMap.get(ref) ?? content : content;
      })
      .replace(/<g\b([^>]*)\/>/g, (_match, attrs: string) => {
        const ref = gaijiRef(attrs);
        return ref ? gaijiMap.get(ref) ?? "" : "";
      })
      .replace(/<[^>]+>/g, "")
      .replace(/\[[A-Z]+\d+[a-z]?\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

const xmlBodyToReaderHtml = (bodyXml: string, gaijiMap: Map<string, string>) => {
  const normalizedXml = bodyXml
    .replace(/<note\b[\s\S]*?<\/note>/g, "")
    .replace(/<app\b[\s\S]*?<\/app>/g, "")
    .replace(/<cb:mulu\b[^>]*\/>/g, "")
    .replace(/<cb:mulu\b[\s\S]*?<\/cb:mulu>/g, "")
    .replace(/<choice\b[\s\S]*?<reg[^>]*>([\s\S]*?)<\/reg>[\s\S]*?<\/choice>/g, "$1")
    .replace(/<g\b([^>]*)>([\s\S]*?)<\/g>/g, (_match, attrs: string, content: string) => {
      const ref = gaijiRef(attrs);
      return ref ? gaijiMap.get(ref) ?? stripTags(content, gaijiMap) : stripTags(content, gaijiMap);
    })
    .replace(/<g\b([^>]*)\/>/g, (_match, attrs: string) => {
      const ref = gaijiRef(attrs);
      return ref ? gaijiMap.get(ref) ?? "" : "";
    });
  const tagPattern = /<[^>]+>/g;
  const output: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const appendText = (text: string) => {
    if (text) {
      output.push(escapeHtml(decodeXml(text)));
    }
  };

  while ((match = tagPattern.exec(normalizedXml))) {
    appendText(normalizedXml.slice(lastIndex, match.index));
    output.push(xmlTagToReaderHtml(match[0]));
    lastIndex = tagPattern.lastIndex;
  }

  appendText(normalizedXml.slice(lastIndex));
  return output.join("");
};

const xmlTagToReaderHtml = (tag: string) => {
  const closing = /^<\s*\//.test(tag);
  const selfClosing = /\/\s*>$/.test(tag);
  const rawName = tag.match(/^<\s*\/?\s*([^\s/>]+)/)?.[1]?.toLowerCase();
  if (!rawName) {
    return "";
  }

  const name = rawName.includes(":") ? rawName.split(":").pop() ?? rawName : rawName;
  if (name === "lb") {
    if (closing) {
      return "";
    }
    const id = tag.match(/\b(?:xml:)?id=(["'])(.*?)\1/)?.[2] ?? "";
    return `<span class="lb"${id ? ` id="${escapeAttribute(id)}"` : ""}></span>`;
  }

  if (["pb", "anchor", "milestone", "mulu", "title"].includes(name)) {
    return "";
  }

  if (name === "body") {
    return closing ? "</div>" : '<div class="cbeta-xml-body">';
  }

  if (name === "div") {
    return closing ? "</div>" : '<div class="cbeta-div">';
  }

  if (name === "lg") {
    return closing ? "</div>" : '<div class="lg regular">';
  }

  if (name === "l") {
    return closing ? "</div></div>" : '<div class="lg-row"><div class="lg-cell">';
  }

  if (["docnumber", "head", "jhead"].includes(name)) {
    return closing ? "</p>" : '<p class="head">';
  }

  if (name === "byline") {
    return closing ? "</p>" : '<p class="byline">';
  }

  if (["p", "item"].includes(name)) {
    return closing ? "</p>" : "<p>";
  }

  if (name === "trailer") {
    return closing ? "</p>" : '<p class="trailer">';
  }

  return selfClosing ? "" : "";
};

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeAttribute = escapeHtml;

const gaijiRef = (attrs: string) => attrs.match(/ref="?#([^"\s/>]+)/)?.[1];

const extractGaijiMap = (xml: string) => {
  const map = new Map<string, string>();
  const charPattern = /<char\b[^>]*(?:xml:)?id="([^"]+)"[^>]*>([\s\S]*?)<\/char>/g;
  let match: RegExpExecArray | null;

  while ((match = charPattern.exec(xml))) {
    const [, id, body] = match;
    const value =
      normalizedFormMapping(body) ??
      unicodeMapping(body) ??
      firstTagText(body, "mapping");
    if (value) {
      map.set(id, value);
    }
  }

  return map;
};

const normalizedFormMapping = (xml: string) => {
  const charPropPattern = /<charProp\b[^>]*>([\s\S]*?)<\/charProp>/g;
  let match: RegExpExecArray | null;

  while ((match = charPropPattern.exec(xml))) {
    const body = match[1];
    const localName = firstTagText(body, "localName");
    if (localName !== "normalized form") {
      continue;
    }

    return firstTagText(body, "value");
  }

  return undefined;
};

const unicodeMapping = (xml: string) => {
  const unicode = xml.match(
    /<mapping\b(?=[^>]*type="(?:normal_unicode|unicode)")[^>]*>\s*U\+([0-9A-Fa-f]+)\s*<\/mapping>/,
  )?.[1];
  if (!unicode) {
    return undefined;
  }

  const codePoint = Number.parseInt(unicode, 16);
  if (!Number.isFinite(codePoint)) {
    return undefined;
  }

  return String.fromCodePoint(codePoint);
};

const firstTagText = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1] ? stripTags(match[1]) : undefined;
};

const normalizeChineseText = (text: string) =>
  text
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "")
    .replace(/(?<=\p{Script=Han})\s+(?=[，。！？；：、」』》）】])/gu, "")
    .replace(/(?<=[「『《（【])\s+(?=\p{Script=Han})/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const firstMatch = (xml: string, patterns: RegExp[], gaijiMap = new Map<string, string>()) => {
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match?.[1]) {
      return stripTags(match[1], gaijiMap);
    }
  }
  return "";
};

const extractTitle = (item: CbetaCatalogItem, xml: string, gaijiMap: Map<string, string>) =>
  firstMatch(
    xml,
    [
      /<title\b(?=[^>]*level="m")(?=[^>]*xml:lang="zh-Hant")[^>]*>([\s\S]*?)<\/title>/,
      /<title\b(?=[^>]*xml:lang="zh-Hant")[^>]*>([\s\S]*?)<\/title>/,
    ],
    gaijiMap,
  ) || item.title;

const extractAuthor = (xml: string, gaijiMap: Map<string, string>) =>
  firstMatch(xml, [/<author[^>]*>([\s\S]*?)<\/author>/], gaijiMap);

const extractExtent = (xml: string, gaijiMap: Map<string, string>) =>
  firstMatch(xml, [/<extent[^>]*>([\s\S]*?)<\/extent>/], gaijiMap);

const extractBodyXml = (xml: string) => {
  const bodyMatch = xml.match(/<body\b[^>]*>[\s\S]*?<\/body>/);
  if (bodyMatch?.[0]) {
    return bodyMatch[0];
  }

  const textMatch = xml.match(/<text\b[^>]*>([\s\S]*?)<\/text>/);
  return textMatch?.[1] ?? xml;
};

const splitIntoBlocks = (
  item: CbetaCatalogItem,
  title: string,
  bodyXml: string,
  gaijiMap: Map<string, string>,
) => {
  const sections: SutraSection[] = [];
  const blocks: TextBlock[] = [];
  let currentSection: SutraSection | undefined;
  let buffer: string[] = [];
  let order = 0;

  const ensureSection = (sectionTitle = title) => {
    if (!currentSection) {
      currentSection = {
        id: `${item.id}-section-${sections.length}`,
        workId: item.id,
        title: toSimplified(sectionTitle),
        order: sections.length,
        blockIds: [],
      };
      sections.push(currentSection);
    }

    return currentSection;
  };

  const beginSection = (sectionTitle: string) => {
    if (currentSection) {
      flushBlock();
    }
    currentSection = {
      id: `${item.id}-section-${sections.length}`,
      workId: item.id,
      title: toSimplified(sectionTitle || title),
      order: sections.length,
      blockIds: [],
    };
    sections.push(currentSection);
  };

  const addBlock = (source: string) => {
    if (!source || source.length < 2) {
      return;
    }

    const section = ensureSection();

    const textSource = normalizeResidualDisplayGlyphs(normalizeDisplayGlyphs(source));
    const block: TextBlock = {
      id: `${item.id}-block-${blocks.length}`,
      workId: item.id,
      sectionId: section.id,
      anchorId: `${item.id}-${order}`,
      order,
      textSource,
      textSimplified: toSimplified(textSource),
    };

    blocks.push(block);
    section.blockIds.push(block.id);
    order += 1;
  };

  const flushBlock = () => {
    const source = normalizeChineseText(stripTags(buffer.join(""), gaijiMap));
    buffer = [];
    addBlock(source);
  };

  const addStandaloneBlock = (xml: string) => {
    flushBlock();
    const source = normalizeChineseText(stripTags(xml, gaijiMap));
    addBlock(source);
  };

  const tokenPattern = /<head\b[^>]*>[\s\S]*?<\/head>|<cb:jhead\b[^>]*>[\s\S]*?<\/cb:jhead>|<byline\b[^>]*>[\s\S]*?<\/byline>|<p\b[^>]*>|<\/(?:p|lg|l|item|trailer)>|<milestone\b[^>]*unit="juan"[^>]*\/>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(bodyXml))) {
    buffer.push(bodyXml.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith("<head") || token.startsWith("<cb:jhead")) {
      const sectionTitle = normalizeChineseText(stripTags(token, gaijiMap));
      beginSection(sectionTitle);
      addStandaloneBlock(token);
    } else if (token.startsWith("<byline")) {
      addStandaloneBlock(token);
    } else if (token.startsWith("<p") || token.startsWith("<milestone")) {
      flushBlock();
    } else if (token.startsWith("</")) {
      flushBlock();
    }

    lastIndex = tokenPattern.lastIndex;
  }

  buffer.push(bodyXml.slice(lastIndex));
  flushBlock();

  if (blocks.length === 0) {
    beginSection(title);
    buffer.push(bodyXml);
    flushBlock();
  }

  return {
    sections: sections.filter((section) => section.blockIds.length > 0),
    blocks,
  };
};

export const parseCbetaXml = (item: CbetaCatalogItem, xml: string): SutraWork => {
  const gaijiMap = extractGaijiMap(xml);
  const title = extractTitle(item, xml, gaijiMap);
  const author = extractAuthor(xml, gaijiMap);
  const extent = extractExtent(xml, gaijiMap);
  const bodyXml = extractBodyXml(xml);
  const { sections, blocks } = splitIntoBlocks(item, title, bodyXml, gaijiMap);
  const readerHtml = xmlBodyToReaderHtml(bodyXml, gaijiMap);

  return {
    id: item.id,
    title: toSimplified(title),
    subtitle: [item.canonTitle, item.sourceId, toSimplified(author), extent]
      .filter(Boolean)
      .join(" - "),
    parserVersion: cbetaParserVersion,
    sourcePath: item.path,
    sourceUrl: item.rawUrl,
    sourceAttribution:
      "Text source: CBETA XML P5. Please keep CBETA attribution and source availability notes with redistributed text.",
    readerHtml,
    sections,
    blocks,
  };
};
