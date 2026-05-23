import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { cbetaCatalog } from "./src/data/cbetaCatalog";
import { sampleSutra } from "./src/data/sampleSutra";
import { isCbetaWorkCached, loadCbetaWork } from "./src/lib/cbeta";
import {
  createProgressSegments,
  createReadRange,
  makePosition,
  offsetToPosition,
  percentRead,
  positionToOffset,
  segmentReadFraction,
  totalChars,
} from "./src/lib/progress";
import { loadReaderState, resetReaderState, saveReaderState } from "./src/lib/storage";
import {
  Bookmark,
  CbetaCatalogItem,
  ProgressSegment,
  ReaderState,
  ReadingPosition,
  SutraWork,
} from "./src/types";

type Screen = "home" | "library" | "outline" | "reader";
type Theme = typeof lightTheme;

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const defaultCatalogItem =
  cbetaCatalog.find((item) => item.id === "T01n0001") ?? cbetaCatalog[0];

export default function App() {
  return (
    <SafeAreaProvider>
      <SutraReaderApp />
    </SafeAreaProvider>
  );
}

function SutraReaderApp() {
  const colorScheme = useColorScheme();
  const dark = colorScheme === "dark";
  const theme = dark ? darkTheme : lightTheme;
  const [screen, setScreen] = useState<Screen>("home");
  const [readerState, setReaderState] = useState<ReaderState>({
    bookmarks: [],
    readRanges: [],
  });
  const [currentWork, setCurrentWork] = useState<SutraWork>(sampleSutra);
  const [currentPosition, setCurrentPosition] = useState<ReadingPosition>(() =>
    offsetToPosition(sampleSutra, 0),
  );
  const [loadingMessage, setLoadingMessage] = useState<string>();

  const workRanges = readerState.readRanges.filter(
    (range) => range.workId === currentWork.id,
  );
  const workBookmarks = readerState.bookmarks.filter(
    (bookmark) => bookmark.workId === currentWork.id,
  );
  const segments = useMemo(() => createProgressSegments(currentWork), [currentWork]);
  const progress = percentRead(currentWork, workRanges);
  const primaryBookmark =
    workBookmarks.find((bookmark) => bookmark.isPrimaryForWork) ?? workBookmarks[0];

  useEffect(() => {
    loadReaderState().then((state) => {
      setReaderState(state);
      const latest = state.lastPosition;
      if (latest?.workId === currentWork.id) {
        setCurrentPosition(latest);
      }
    });
  }, [currentWork.id]);

  const persist = (nextState: ReaderState) => {
    setReaderState(nextState);
    saveReaderState(nextState);
  };

  const openReaderAt = (position: ReadingPosition) => {
    setCurrentPosition(position);
    persist({ ...readerState, lastPosition: position });
    setScreen("reader");
  };

  const openCatalogItem = async (item: CbetaCatalogItem) => {
    setLoadingMessage(`Loading ${item.title}`);
    try {
      const work = await loadCbetaWork(item);
      setCurrentWork(work);
      const bookmark = readerState.bookmarks.find((candidate) => candidate.workId === work.id);
      const start = bookmark?.position ?? offsetToPosition(work, 0);
      setCurrentPosition(start);
      persist({ ...readerState, lastPosition: start });
      setScreen("home");
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "Unable to load this CBETA work",
      );
      return;
    }
    setLoadingMessage(undefined);
  };

  const startSession = () => {
    persist({ ...readerState, activeSessionStart: currentPosition });
  };

  const markHere = () => {
    const activeStart =
      readerState.activeSessionStart?.workId === currentWork.id
        ? readerState.activeSessionStart
        : undefined;
    const start = activeStart ?? primaryBookmark?.position ?? currentPosition;
    const range = createReadRange(currentWork, start, currentPosition);
    const bookmark = createBookmark(currentWork, currentPosition, true);

    persist({
      ...readerState,
      activeSessionStart: undefined,
      lastPosition: currentPosition,
      readRanges: [...readerState.readRanges, range],
      bookmarks: upsertPrimaryBookmark(readerState.bookmarks, bookmark),
    });
    setScreen("home");
  };

  const saveBookmark = () => {
    const bookmark = createBookmark(currentWork, currentPosition, false);
    persist({
      ...readerState,
      lastPosition: currentPosition,
      bookmarks: [bookmark, ...readerState.bookmarks],
    });
  };

  const resetProgress = () => {
    const nextState = { bookmarks: [], readRanges: [] };
    const start = offsetToPosition(currentWork, 0);
    setCurrentPosition(start);
    setReaderState(nextState);
    resetReaderState();
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={dark ? "light" : "dark"} />
      {screen === "home" ? (
        <HomeScreen
          theme={theme}
          currentWork={currentWork}
          segments={segments}
          readerState={readerState}
          workRanges={workRanges}
          progress={progress}
          loadingMessage={loadingMessage}
          onOpenLibrary={() => setScreen("library")}
          onOpenOutline={() => setScreen("outline")}
          onContinue={() =>
            openReaderAt(primaryBookmark?.position ?? readerState.lastPosition ?? currentPosition)
          }
          onOpenSegment={(segment) =>
            openReaderAt(offsetToPosition(currentWork, segment.startOffset))
          }
          onLoadDefault={() => openCatalogItem(defaultCatalogItem)}
          onReset={resetProgress}
        />
      ) : null}
      {screen === "library" ? (
        <LibraryScreen
          theme={theme}
          loadingMessage={loadingMessage}
          onBack={() => setScreen("home")}
          onOpen={openCatalogItem}
        />
      ) : null}
      {screen === "outline" ? (
        <OutlineScreen
          theme={theme}
          work={currentWork}
          readerState={readerState}
          onBack={() => setScreen("home")}
          onOpen={openReaderAt}
        />
      ) : null}
      {screen === "reader" ? (
        <ReaderScreen
          theme={theme}
          work={currentWork}
          position={currentPosition}
          readerState={readerState}
          onBack={() => setScreen("home")}
          onPositionChange={(position) => {
            setCurrentPosition(position);
            saveReaderState({ ...readerState, lastPosition: position });
          }}
          onStart={startSession}
          onMarkHere={markHere}
          onBookmark={saveBookmark}
        />
      ) : null}
    </SafeAreaView>
  );
}

function HomeScreen({
  theme,
  currentWork,
  segments,
  readerState,
  workRanges,
  progress,
  loadingMessage,
  onOpenLibrary,
  onOpenOutline,
  onContinue,
  onOpenSegment,
  onLoadDefault,
  onReset,
}: {
  theme: Theme;
  currentWork: SutraWork;
  segments: ProgressSegment[];
  readerState: ReaderState;
  workRanges: ReaderState["readRanges"];
  progress: number;
  loadingMessage?: string;
  onOpenLibrary: () => void;
  onOpenOutline: () => void;
  onContinue: () => void;
  onOpenSegment: (segment: ProgressSegment) => void;
  onLoadDefault: () => void;
  onReset: () => void;
}) {
  const workBookmarks = readerState.bookmarks.filter(
    (bookmark) => bookmark.workId === currentWork.id,
  );

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={[styles.appTitle, { color: theme.text }]}>Sutra Reader</Text>
          <Text style={[styles.subtitle, { color: theme.muted }]} numberOfLines={2}>
            {currentWork.title}
          </Text>
        </View>
        <Text style={[styles.percent, { color: theme.accent }]}>
          {Math.round(progress * 100)}%
        </Text>
      </View>

      <Text style={[styles.catalogMeta, { color: theme.muted }]}>
        CBETA library: {cbetaCatalog.length.toLocaleString()} works available
      </Text>

      <View style={styles.mapGrid}>
        {segments.map((segment) => (
          <ProgressDot
            key={segment.id}
            theme={theme}
            fraction={segmentReadFraction(currentWork, segment, workRanges)}
            bookmarked={workBookmarks.some((bookmark) => {
              const offset = positionToOffset(currentWork, bookmark.position);
              return offset >= segment.startOffset && offset < segment.endOffset;
            })}
            label={segment.label}
            onPress={() => onOpenSegment(segment)}
          />
        ))}
      </View>

      <View style={styles.actionRow}>
        <Button label="Continue" theme={theme} filled onPress={onContinue} />
        <Button label="Library" theme={theme} onPress={onOpenLibrary} />
        <Button label="Outline" theme={theme} onPress={onOpenOutline} />
      </View>

      {currentWork.id === sampleSutra.id ? (
        <Pressable onPress={onLoadDefault} style={styles.notice}>
          <Text style={[styles.noticeText, { color: theme.accent }]}>
            Download the first CBETA work to replace sample content.
          </Text>
        </Pressable>
      ) : null}

      {loadingMessage ? (
        <Text style={[styles.loadingText, { color: theme.accent }]}>{loadingMessage}</Text>
      ) : null}

      <View style={styles.panel}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Active bookmarks</Text>
        {workBookmarks.slice(0, 4).map((bookmark) => (
          <Text key={bookmark.id} style={[styles.bookmark, { color: theme.muted }]}>
            {bookmark.title}
          </Text>
        ))}
        {workBookmarks.length === 0 ? (
          <Text style={[styles.bookmark, { color: theme.muted }]}>No bookmarks yet</Text>
        ) : null}
      </View>

      {currentWork.sourceAttribution ? (
        <Text style={[styles.sourceText, { color: theme.muted }]}>
          {currentWork.sourceAttribution}
        </Text>
      ) : null}

      <Pressable onPress={onReset} style={styles.resetButton}>
        <Text style={[styles.resetText, { color: theme.muted }]}>Reset local progress</Text>
      </Pressable>
    </View>
  );
}

function LibraryScreen({
  theme,
  loadingMessage,
  onBack,
  onOpen,
}: {
  theme: Theme;
  loadingMessage?: string;
  onBack: () => void;
  onOpen: (item: CbetaCatalogItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [cachedIds, setCachedIds] = useState<Record<string, boolean>>({});
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const items = needle
      ? cbetaCatalog.filter((item) =>
          `${item.title} ${item.sourceId} ${item.canonTitle} ${item.path}`
            .toLowerCase()
            .includes(needle),
        )
      : cbetaCatalog;
    return items.slice(0, 160);
  }, [query]);

  useEffect(() => {
    Promise.all(
      filtered.slice(0, 40).map(async (item) => [item.id, await isCbetaWorkCached(item)] as const),
    ).then((pairs) => {
      setCachedIds(Object.fromEntries(pairs));
    });
  }, [filtered]);

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title="CBETA Library" onBack={onBack} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search title, canon, or source id"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        style={[
          styles.searchInput,
          { borderColor: theme.border, color: theme.text, backgroundColor: theme.input },
        ]}
      />
      <Text style={[styles.catalogMeta, { color: theme.muted }]}>
        Showing {filtered.length} of {cbetaCatalog.length.toLocaleString()} works. Tap to download
        and cache for offline reading.
      </Text>
      {loadingMessage ? (
        <Text style={[styles.loadingText, { color: theme.accent }]}>{loadingMessage}</Text>
      ) : null}
      <ScrollView showsVerticalScrollIndicator={false}>
        {filtered.map((item) => (
          <Pressable
            key={item.path}
            onPress={() => onOpen(item)}
            style={[styles.libraryRow, { borderColor: theme.border }]}
          >
            <View style={styles.libraryText}>
              <Text style={[styles.outlineTitle, { color: theme.text }]} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[styles.outlineMeta, { color: theme.muted }]} numberOfLines={1}>
                {item.canonTitle} - {item.volume} - {item.sourceId}
              </Text>
            </View>
            <Text style={[styles.cacheBadge, { color: theme.accent }]}>
              {cachedIds[item.id] ? "Cached" : "Get"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function OutlineScreen({
  theme,
  work,
  readerState,
  onBack,
  onOpen,
}: {
  theme: Theme;
  work: SutraWork;
  readerState: ReaderState;
  onBack: () => void;
  onOpen: (position: ReadingPosition) => void;
}) {
  const workRanges = readerState.readRanges.filter((range) => range.workId === work.id);

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title="Outline" onBack={onBack} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {work.sections.map((section) => {
          const firstBlock = work.blocks.find((block) => block.id === section.blockIds[0]);
          const sectionStart = firstBlock ? makePosition(work.id, firstBlock, 0, 0) : null;
          const offsets = section.blockIds.flatMap((blockId) => {
            const block = work.blocks.find((item) => item.id === blockId);
            if (!block) {
              return [];
            }
            const start = positionToOffset(work, makePosition(work.id, block, 0, 0));
            return [start, start + block.textSimplified.length];
          });
          const startOffset = offsets.length ? Math.min(...offsets) : 0;
          const endOffset = offsets.length ? Math.max(...offsets) : 0;
          const fraction = segmentReadFraction(
            work,
            {
              id: section.id,
              workId: work.id,
              order: section.order,
              startOffset,
              endOffset,
              label: section.title,
            },
            workRanges,
          );

          return (
            <Pressable
              key={section.id}
              disabled={!sectionStart}
              onPress={() => sectionStart && onOpen(sectionStart)}
              style={[styles.outlineRow, { borderColor: theme.border }]}
            >
              <View style={styles.libraryText}>
                <Text style={[styles.outlineTitle, { color: theme.text }]} numberOfLines={1}>
                  {section.title}
                </Text>
                <Text style={[styles.outlineMeta, { color: theme.muted }]}>
                  {section.blockIds.length} blocks - {Math.round(fraction * 100)}% read
                </Text>
              </View>
              <MiniBar theme={theme} fraction={fraction} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ReaderScreen({
  theme,
  work,
  position,
  readerState,
  onBack,
  onPositionChange,
  onStart,
  onMarkHere,
  onBookmark,
}: {
  theme: Theme;
  work: SutraWork;
  position: ReadingPosition;
  readerState: ReaderState;
  onBack: () => void;
  onPositionChange: (position: ReadingPosition) => void;
  onStart: () => void;
  onMarkHere: () => void;
  onBookmark: () => void;
}) {
  const activeBlock = work.blocks.find((block) => block.id === position.textBlockId);
  const sessionActive = readerState.activeSessionStart?.workId === work.id;

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title={work.title} onBack={onBack} />
      <Text style={[styles.readerSubhead, { color: theme.muted }]} numberOfLines={2}>
        {work.subtitle}
      </Text>

      <FlatList
        data={work.blocks}
        keyExtractor={(block) => block.id}
        showsVerticalScrollIndicator={false}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const scrollable = Math.max(1, contentSize.height - layoutMeasurement.height);
          const fraction = Math.max(0, Math.min(contentOffset.y / scrollable, 1));
          onPositionChange(
            offsetToPosition(work, Math.floor(totalChars(work) * fraction), fraction),
          );
        }}
        scrollEventThrottle={350}
        style={styles.readerScroll}
        renderItem={({ item: block }) => (
          <Pressable
            onPress={() =>
              onPositionChange(
                makePosition(
                  work.id,
                  block,
                  Math.floor(block.textSimplified.length / 2),
                  position.scrollFraction,
                ),
              )
            }
            style={[
              styles.readerBlock,
              activeBlock?.id === block.id
                ? { backgroundColor: theme.selection }
                : { backgroundColor: "transparent" },
            ]}
          >
            {block.title ? (
              <Text style={[styles.blockTitle, { color: theme.accent }]}>{block.title}</Text>
            ) : null}
            <Text style={[styles.readerText, { color: theme.text }]}>
              {block.textSimplified}
            </Text>
          </Pressable>
        )}
      />

      <View style={[styles.readerFooter, { borderColor: theme.border }]}>
        <Text style={[styles.sessionText, { color: theme.muted }]}>
          {sessionActive ? "Session active" : "Ready"}
        </Text>
        <View style={styles.readerActions}>
          <Button label="Start" theme={theme} onPress={onStart} />
          <Button label="Bookmark" theme={theme} onPress={onBookmark} />
          <Button label="Mark Here" theme={theme} filled onPress={onMarkHere} />
        </View>
      </View>
    </View>
  );
}

function ProgressDot({
  theme,
  fraction,
  bookmarked,
  label,
  onPress,
}: {
  theme: Theme;
  fraction: number;
  bookmarked: boolean;
  label: string;
  onPress: () => void;
}) {
  const fillColor = fraction >= 1 ? theme.accent : fraction > 0 ? theme.partial : theme.dot;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${Math.round(fraction * 100)} percent read`}
      onPress={onPress}
      style={[
        styles.dotHit,
        bookmarked ? { borderColor: theme.accent, borderWidth: 1 } : null,
      ]}
    >
      <View
        style={[
          styles.dot,
          {
            backgroundColor: fillColor,
            opacity: fraction > 0 ? 1 : 0.34,
            transform: [{ scale: fraction > 0 && fraction < 1 ? 0.78 : 1 }],
          },
        ]}
      />
    </Pressable>
  );
}

function Button({
  label,
  theme,
  filled,
  onPress,
}: {
  label: string;
  theme: Theme;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.button,
        {
          backgroundColor: filled ? theme.accent : "transparent",
          borderColor: filled ? theme.accent : theme.border,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: filled ? theme.onAccent : theme.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function TopBar({
  theme,
  title,
  onBack,
}: {
  theme: Theme;
  title: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.topBar}>
      <Pressable onPress={onBack} style={styles.backButton}>
        <Text style={[styles.backText, { color: theme.accent }]}>Back</Text>
      </Pressable>
      <Text style={[styles.topTitle, { color: theme.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.backButton} />
    </View>
  );
}

function MiniBar({ theme, fraction }: { theme: Theme; fraction: number }) {
  return (
    <View style={[styles.miniBar, { backgroundColor: theme.dot }]}>
      <View
        style={[
          styles.miniBarFill,
          { backgroundColor: theme.accent, width: `${Math.round(fraction * 100)}%` },
        ]}
      />
    </View>
  );
}

function createBookmark(
  work: SutraWork,
  position: ReadingPosition,
  primary: boolean,
): Bookmark {
  const block = work.blocks.find((item) => item.id === position.textBlockId);
  const section = work.sections.find((item) => item.id === block?.sectionId);
  const now = new Date().toISOString();

  return {
    id: makeId(),
    workId: work.id,
    position,
    title: `${work.title} - ${section?.title ?? work.subtitle}`,
    isPrimaryForWork: primary,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertPrimaryBookmark(bookmarks: Bookmark[], bookmark: Bookmark) {
  return [
    bookmark,
    ...bookmarks
      .map((item) =>
        item.workId === bookmark.workId ? { ...item, isPrimaryForWork: false } : item,
      )
      .slice(0, 40),
  ];
}

const lightTheme = {
  background: "#faf8f2",
  text: "#25231d",
  muted: "#746f65",
  border: "#ddd6c8",
  accent: "#7f5539",
  onAccent: "#fffaf0",
  partial: "#b08968",
  dot: "#d8d0c2",
  input: "#fffdf7",
  selection: "#efe4d2",
};

const darkTheme = {
  background: "#171612",
  text: "#f5f0e7",
  muted: "#b9afa0",
  border: "#39342c",
  accent: "#d6a36f",
  onAccent: "#1e160f",
  partial: "#a98467",
  dot: "#4a4237",
  input: "#211e19",
  selection: "#2c261f",
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  headerRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  appTitle: {
    fontSize: 31,
    fontWeight: "700",
    letterSpacing: 0,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    marginTop: 4,
  },
  catalogMeta: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 16,
  },
  percent: {
    fontSize: 28,
    fontWeight: "700",
  },
  mapGrid: {
    alignContent: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginHorizontal: "auto",
    maxWidth: 312,
    rowGap: 10,
  },
  dotHit: {
    alignItems: "center",
    borderRadius: 8,
    height: 42,
    justifyContent: "center",
    marginHorizontal: 5,
    width: 42,
  },
  dot: {
    borderRadius: 5,
    height: 13,
    width: 13,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 26,
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  notice: {
    marginTop: 16,
  },
  noticeText: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    marginBottom: 8,
  },
  panel: {
    marginTop: 24,
  },
  panelTitle: {
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 8,
  },
  bookmark: {
    fontSize: 15,
    lineHeight: 24,
  },
  sourceText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 18,
  },
  resetButton: {
    marginTop: "auto",
    paddingVertical: 18,
  },
  resetText: {
    fontSize: 13,
    textAlign: "center",
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    height: 44,
    justifyContent: "space-between",
    marginBottom: 12,
  },
  backButton: {
    width: 68,
  },
  backText: {
    fontSize: 16,
    fontWeight: "700",
  },
  topTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  searchInput: {
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    marginBottom: 10,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  libraryRow: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 70,
    paddingVertical: 12,
  },
  libraryText: {
    flex: 1,
    paddingRight: 12,
  },
  cacheBadge: {
    fontSize: 13,
    fontWeight: "700",
  },
  outlineRow: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 78,
    paddingVertical: 14,
  },
  outlineTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  outlineMeta: {
    fontSize: 14,
    marginTop: 5,
  },
  miniBar: {
    borderRadius: 4,
    height: 8,
    overflow: "hidden",
    width: 76,
  },
  miniBarFill: {
    borderRadius: 4,
    height: 8,
  },
  readerSubhead: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
    textAlign: "center",
  },
  readerScroll: {
    flex: 1,
  },
  readerBlock: {
    borderRadius: 8,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  blockTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  readerText: {
    fontSize: 24,
    lineHeight: 42,
  },
  readerFooter: {
    borderTopWidth: 1,
    paddingTop: 12,
  },
  sessionText: {
    fontSize: 13,
    marginBottom: 10,
    textAlign: "center",
  },
  readerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    paddingBottom: 8,
  },
});
