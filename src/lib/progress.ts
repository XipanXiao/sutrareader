import {
  ProgressSegment,
  ReadRange,
  ReadingPosition,
  SutraWork,
  TextBlock,
} from "../types";

const id = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const totalChars = (work: SutraWork) =>
  work.blocks.reduce((sum, block) => sum + block.textSimplified.length, 0);

export const blockStartOffset = (work: SutraWork, blockId: string) => {
  let offset = 0;
  for (const block of work.blocks) {
    if (block.id === blockId) {
      return offset;
    }
    offset += block.textSimplified.length;
  }
  return 0;
};

export const positionToOffset = (work: SutraWork, position: ReadingPosition) => {
  const block = work.blocks.find((item) => item.id === position.textBlockId);
  if (!block) {
    return 0;
  }

  const safeOffset = Math.max(
    0,
    Math.min(position.charOffset, block.textSimplified.length),
  );

  return blockStartOffset(work, block.id) + safeOffset;
};

export const offsetToPosition = (
  work: SutraWork,
  offset: number,
  scrollFraction = 0,
): ReadingPosition => {
  const safeOffset = Math.max(0, Math.min(offset, totalChars(work)));
  let cursor = 0;

  for (const block of work.blocks) {
    const next = cursor + block.textSimplified.length;
    if (safeOffset <= next) {
      return makePosition(work.id, block, safeOffset - cursor, scrollFraction);
    }
    cursor = next;
  }

  const lastBlock = work.blocks[work.blocks.length - 1];
  return makePosition(
    work.id,
    lastBlock,
    lastBlock.textSimplified.length,
    scrollFraction,
  );
};

export const makePosition = (
  workId: string,
  block: TextBlock,
  charOffset: number,
  scrollFraction: number,
): ReadingPosition => ({
  id: id(),
  workId,
  anchorId: block.anchorId,
  textBlockId: block.id,
  charOffset: Math.max(0, Math.min(charOffset, block.textSimplified.length)),
  scrollFraction: Math.max(0, Math.min(scrollFraction, 1)),
  createdAt: new Date().toISOString(),
});

export const createProgressSegments = (
  work: SutraWork,
  segmentCount = 36,
): ProgressSegment[] => {
  const chars = totalChars(work);
  const sectionByBlock = new Map(
    work.sections.flatMap((section) =>
      section.blockIds.map((blockId) => [blockId, section.title] as const),
    ),
  );

  return Array.from({ length: segmentCount }, (_, index) => {
    const startOffset = Math.floor((chars * index) / segmentCount);
    const endOffset = Math.floor((chars * (index + 1)) / segmentCount);
    const startPosition = offsetToPosition(work, startOffset);
    const block = work.blocks.find((item) => item.id === startPosition.textBlockId);
    const sectionTitle = block ? sectionByBlock.get(block.id) : work.subtitle;

    return {
      id: `segment-${index}`,
      workId: work.id,
      order: index,
      startOffset,
      endOffset,
      label: `${work.title} - ${sectionTitle ?? work.subtitle}`,
    };
  });
};

const overlap = (
  startA: number,
  endA: number,
  startB: number,
  endB: number,
) => Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));

export const segmentReadFraction = (
  work: SutraWork,
  segment: ProgressSegment,
  ranges: ReadRange[],
) => {
  const segmentLength = Math.max(1, segment.endOffset - segment.startOffset);
  const intervals = ranges
    .map((range) => {
      const start = positionToOffset(work, range.start);
      const end = positionToOffset(work, range.end);
      return [Math.min(start, end), Math.max(start, end)] as const;
    })
    .filter(([start, end]) => overlap(segment.startOffset, segment.endOffset, start, end) > 0)
    .sort(([a], [b]) => a - b);

  let read = 0;
  let mergedStart: number | undefined;
  let mergedEnd: number | undefined;

  for (const [start, end] of intervals) {
    const clippedStart = Math.max(segment.startOffset, start);
    const clippedEnd = Math.min(segment.endOffset, end);

    if (mergedStart === undefined || mergedEnd === undefined) {
      mergedStart = clippedStart;
      mergedEnd = clippedEnd;
      continue;
    }

    if (clippedStart <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, clippedEnd);
    } else {
      read += mergedEnd - mergedStart;
      mergedStart = clippedStart;
      mergedEnd = clippedEnd;
    }
  }

  if (mergedStart !== undefined && mergedEnd !== undefined) {
    read += mergedEnd - mergedStart;
  }

  return Math.max(0, Math.min(read / segmentLength, 1));
};

export const createReadRange = (
  work: SutraWork,
  start: ReadingPosition,
  end: ReadingPosition,
): ReadRange => {
  const startOffset = positionToOffset(work, start);
  const endOffset = positionToOffset(work, end);
  const orderedStartOffset = Math.min(startOffset, endOffset);
  const orderedEndOffset = Math.max(startOffset, endOffset);

  return {
    id: id(),
    workId: work.id,
    start: startOffset <= endOffset ? start : end,
    end: startOffset <= endOffset ? end : start,
    startOffset: orderedStartOffset,
    endOffset: orderedEndOffset,
    workTotalChars: totalChars(work),
    createdAt: new Date().toISOString(),
  };
};

export const percentRead = (work: SutraWork, ranges: ReadRange[]) => {
  const segment = {
    id: "all",
    workId: work.id,
    order: 0,
    startOffset: 0,
    endOffset: totalChars(work),
    label: work.title,
  };

  return segmentReadFraction(work, segment, ranges);
};
