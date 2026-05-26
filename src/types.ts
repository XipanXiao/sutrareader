export type TextBlock = {
  id: string;
  workId: string;
  sectionId: string;
  anchorId: string;
  order: number;
  title?: string;
  textSimplified: string;
  textSource: string;
};

export type SutraSection = {
  id: string;
  workId: string;
  title: string;
  order: number;
  blockIds: string[];
};

export type SutraWork = {
  id: string;
  title: string;
  subtitle: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceAttribution?: string;
  sections: SutraSection[];
  blocks: TextBlock[];
};

export type CbetaCanon = {
  title: string;
  "title-zh": string;
  "short-title-zh": string;
  abbreviation: string;
  volumes: number;
};

export type CbetaCatalogItem = {
  id: string;
  sourceId: string;
  canon: string;
  canonTitle: string;
  volume: string;
  number: string;
  title: string;
  titleSimplified?: string;
  canonTitleSimplified?: string;
  searchText?: string;
  path: string;
  rawUrl: string;
};

export type ReadingPosition = {
  id: string;
  workId: string;
  anchorId: string;
  textBlockId: string;
  charOffset: number;
  scrollFraction: number;
  createdAt: string;
};

export type Bookmark = {
  id: string;
  workId: string;
  position: ReadingPosition;
  title: string;
  note?: string;
  isPrimaryForWork: boolean;
  isCompletionAnchor?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ReadRange = {
  id: string;
  workId: string;
  start: ReadingPosition;
  end: ReadingPosition;
  startOffset?: number;
  endOffset?: number;
  workTotalChars?: number;
  createdAt: string;
};

export type ProgressSegment = {
  id: string;
  workId: string;
  order: number;
  startOffset: number;
  endOffset: number;
  label: string;
};

export type ReaderState = {
  bookmarks: Bookmark[];
  readRanges: ReadRange[];
  activeSessionStart?: ReadingPosition;
  lastPosition?: ReadingPosition;
};
