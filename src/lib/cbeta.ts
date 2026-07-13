import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Converter } from "opencc-js";
import { CbetaCatalogItem, SutraSection, SutraWork, TextBlock } from "../types";

const cacheDirectory = `${FileSystem.documentDirectory ?? ""}cbeta-cache`;
const toSimplified = Converter({ from: "tw", to: "cn" });
const preferredSourceKey = "sutrareader.cbetaPreferredSource.v1";
const sourceTimeoutMs = 8000;
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
    if (shouldRefreshCachedWork(work)) {
      await FileSystem.deleteAsync(cachePath, { idempotent: true });
    } else {
      const normalized = normalizeCachedWork(work);
      if (normalized.changed) {
        await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(normalized.work));
      }
      return normalized.work;
    }
  }

  const xml = await fetchCbetaXml(item);
  const work = parseCbetaXml(item, xml);
  await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(work));
  return work;
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

const shouldRefreshCachedWork = (work: SutraWork) => {
  if (!work.blocks.length) {
    return true;
  }

  const hasUnresolvedGaiji = work.blocks.some(
    (block) => block.textSimplified.includes("□") || block.textSource.includes("□"),
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
      .replace(/<choice[\s\S]*?<reg[^>]*>([\s\S]*?)<\/reg>[\s\S]*?<\/choice>/g, "$1")
      .replace(/<g\b[^>]*>([\s\S]*?)<\/g>/g, "$1")
      .replace(/<g\b([^>]*)\/>/g, (_match, attrs: string) => {
        const ref = attrs.match(/ref="?#([^"\s/>]+)/)?.[1];
        return ref ? gaijiMap.get(ref) ?? "" : "";
      })
      .replace(/<[^>]+>/g, "")
      .replace(/\[[A-Z]+\d+[a-z]?\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

const extractGaijiMap = (xml: string) => {
  const map = new Map<string, string>();
  const charPattern = /<char\b[^>]*(?:xml:)?id="([^"]+)"[^>]*>([\s\S]*?)<\/char>/g;
  let match: RegExpExecArray | null;

  while ((match = charPattern.exec(xml))) {
    const [, id, body] = match;
    const value =
      unicodeMapping(body) ??
      firstTagText(body, "charProp") ??
      firstTagText(body, "charName") ??
      firstTagText(body, "mapping");
    if (value) {
      map.set(id, value);
    }
  }

  return map;
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
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "")
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[，。！？；：、」』》）】])/g, "")
    .replace(/(?<=[「『《（【])\s+(?=[\u3400-\u9fff])/g, "")
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
  const match = xml.match(/<text[\s\S]*?>([\s\S]*?)<\/text>/);
  return match?.[1] ?? xml;
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

  const flushBlock = () => {
    const source = normalizeChineseText(stripTags(buffer.join(""), gaijiMap));
    buffer = [];

    if (!source || source.length < 2) {
      return;
    }

    if (!currentSection) {
      currentSection = {
        id: `${item.id}-section-${sections.length}`,
        workId: item.id,
        title: toSimplified(title),
        order: sections.length,
        blockIds: [],
      };
      sections.push(currentSection);
    }

    const block: TextBlock = {
      id: `${item.id}-block-${blocks.length}`,
      workId: item.id,
      sectionId: currentSection.id,
      anchorId: `${item.id}-${order}`,
      order,
      textSource: source,
      textSimplified: toSimplified(source),
    };

    blocks.push(block);
    currentSection.blockIds.push(block.id);
    order += 1;
  };

  const tokenPattern = /<head\b[^>]*>[\s\S]*?<\/head>|<p\b[^>]*>|<\/(?:p|lg|l|item|trailer)>|<milestone\b[^>]*unit="juan"[^>]*\/>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(bodyXml))) {
    buffer.push(bodyXml.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith("<head")) {
      beginSection(stripTags(token, gaijiMap));
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

  return {
    id: item.id,
    title: toSimplified(title),
    subtitle: [item.canonTitle, item.sourceId, toSimplified(author), extent]
      .filter(Boolean)
      .join(" - "),
    sourcePath: item.path,
    sourceUrl: item.rawUrl,
    sourceAttribution:
      "Text source: CBETA XML P5. Please keep CBETA attribution and source availability notes with redistributed text.",
    sections,
    blocks,
  };
};
