import * as FileSystem from "expo-file-system/legacy";
import { Converter } from "opencc-js";
import { CbetaCatalogItem, SutraSection, SutraWork, TextBlock } from "../types";

const cacheDirectory = `${FileSystem.documentDirectory ?? ""}cbeta-cache`;
const toSimplified = Converter({ from: "tw", to: "cn" });

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
      return work;
    }
  }

  const response = await fetch(item.rawUrl);
  if (!response.ok) {
    throw new Error(`无法从 CBETA 下载 ${item.sourceId}`);
  }

  const xml = await response.text();
  const work = parseCbetaXml(item, xml);
  await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(work));
  return work;
};

const shouldRefreshCachedWork = (work: SutraWork) => {
  if (!work.blocks.length) {
    return true;
  }

  const shortBlocks = work.blocks.filter((block) => block.textSimplified.length < 28).length;
  return work.blocks.length > 80 && shortBlocks / work.blocks.length > 0.35;
};

const decodeXml = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");

const stripTags = (xml: string) =>
  decodeXml(
    xml
      .replace(/<note[\s\S]*?<\/note>/g, "")
      .replace(/<app[\s\S]*?<\/app>/g, "")
      .replace(/<choice[\s\S]*?<reg[^>]*>([\s\S]*?)<\/reg>[\s\S]*?<\/choice>/g, "$1")
      .replace(/<g\b[^>]*>([\s\S]*?)<\/g>/g, "$1")
      .replace(/<g\b[^/]*\/>/g, "□")
      .replace(/<[^>]+>/g, "")
      .replace(/\[[A-Z]+\d+[a-z]?\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

const firstMatch = (xml: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match?.[1]) {
      return stripTags(match[1]);
    }
  }
  return "";
};

const extractTitle = (item: CbetaCatalogItem, xml: string) =>
  firstMatch(xml, [
    /<title\b(?=[^>]*level="m")(?=[^>]*xml:lang="zh-Hant")[^>]*>([\s\S]*?)<\/title>/,
    /<title\b(?=[^>]*xml:lang="zh-Hant")[^>]*>([\s\S]*?)<\/title>/,
  ]) || item.title;

const extractAuthor = (xml: string) => firstMatch(xml, [/<author[^>]*>([\s\S]*?)<\/author>/]);

const extractExtent = (xml: string) => firstMatch(xml, [/<extent[^>]*>([\s\S]*?)<\/extent>/]);

const extractBodyXml = (xml: string) => {
  const match = xml.match(/<text[\s\S]*?>([\s\S]*?)<\/text>/);
  return match?.[1] ?? xml;
};

const splitIntoBlocks = (item: CbetaCatalogItem, title: string, bodyXml: string) => {
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
    const source = stripTags(buffer.join(""));
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

  const tokenPattern = /<head\b[^>]*>[\s\S]*?<\/head>|<p\b[^>]*>|<\/p>|<milestone\b[^>]*unit="juan"[^>]*\/>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(bodyXml))) {
    buffer.push(bodyXml.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith("<head")) {
      beginSection(stripTags(token));
    } else if (token === "</p>") {
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
  const title = extractTitle(item, xml);
  const author = extractAuthor(xml);
  const extent = extractExtent(xml);
  const bodyXml = extractBodyXml(xml);
  const { sections, blocks } = splitIntoBlocks(item, title, bodyXml);

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
