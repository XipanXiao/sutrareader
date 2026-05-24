import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  FlatList,
  PanResponder,
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
  ReaderState,
  ReadingPosition,
  SutraWork,
} from "./src/types";

type Screen = "home" | "library" | "outline" | "reader";
type Theme = typeof lightTheme;
type GlobalProgressSegment = {
  id: string;
  order: number;
  startIndex: number;
  endIndex: number;
  label: string;
};

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const completedThreshold = 0.999;
const defaultCatalogItem =
  cbetaCatalog.find((item) => item.id === "T01n0001") ?? cbetaCatalog[0];
const catalogIndexById = new Map(
  cbetaCatalog.map((item, index) => [item.id, index] as const),
);

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
  const [readerOpenKey, setReaderOpenKey] = useState(0);

  const workRanges = readerState.readRanges.filter(
    (range) => range.workId === currentWork.id,
  );
  const completedWorkIds = useMemo(
    () => completedWorkIdsFromRanges(readerState.readRanges),
    [readerState.readRanges],
  );
  const workBookmarks = readerState.bookmarks.filter(
    (bookmark) =>
      bookmark.workId === currentWork.id && !completedWorkIds.has(bookmark.workId),
  );
  const progress = percentRead(currentWork, workRanges);
  const globalProgress = useMemo(
    () => calculateGlobalProgress(readerState.readRanges),
    [readerState.readRanges],
  );
  const globalSegments = useMemo(() => createGlobalProgressSegments(144), []);
  const primaryBookmark =
    workBookmarks.find((bookmark) => bookmark.isPrimaryForWork) ?? workBookmarks[0];

  useEffect(() => {
    loadReaderState().then((state) => {
      const normalized = normalizeReaderState(state);
      setReaderState(normalized);
      if (JSON.stringify(normalized) !== JSON.stringify(state)) {
        saveReaderState(normalized);
      }
      const latest = normalized.lastPosition;
      if (latest?.workId === currentWork.id) {
        setCurrentPosition(latest);
      }
    });
  }, [currentWork.id]);

  const persist = (nextState: ReaderState) => {
    const normalized = normalizeReaderState(nextState);
    setReaderState(normalized);
    saveReaderState(normalized);
  };

  const openReaderAt = (position: ReadingPosition) => {
    setCurrentPosition(position);
    persist({ ...readerState, lastPosition: position });
    setReaderOpenKey((value) => value + 1);
    setScreen("reader");
  };

  const openCatalogItem = async (item: CbetaCatalogItem, destination: Screen = "home") => {
    setLoadingMessage(`Loading ${item.title}`);
    try {
      const work = await loadCbetaWork(item);
      setCurrentWork(work);
      const bookmark = readerState.bookmarks.find((candidate) => candidate.workId === work.id);
      const start = bookmark?.position ?? offsetToPosition(work, 0);
      setCurrentPosition(start);
      persist({ ...readerState, lastPosition: start });
      if (destination === "reader") {
        setReaderOpenKey((value) => value + 1);
      }
      setScreen(destination);
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "Unable to load this CBETA work",
      );
      return;
    }
    setLoadingMessage(undefined);
  };

  const openBookmark = async (bookmark: Bookmark) => {
    if (bookmark.workId === currentWork.id) {
      openReaderAt(bookmark.position);
      return;
    }

    const item = cbetaCatalog.find((candidate) => candidate.id === bookmark.workId);
    if (!item) {
      setLoadingMessage("Unable to find the bookmarked sutra in the library");
      return;
    }

    setLoadingMessage(`Loading ${item.title}`);
    try {
      const work = await loadCbetaWork(item);
      setCurrentWork(work);
      setCurrentPosition(bookmark.position);
      persist({ ...readerState, lastPosition: bookmark.position });
      setReaderOpenKey((value) => value + 1);
      setScreen("reader");
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "Unable to load this bookmarked sutra",
      );
      return;
    }
    setLoadingMessage(undefined);
  };

  const deleteBookmark = (bookmark: Bookmark) => {
    const nextBookmarks = readerState.bookmarks.filter((item) => item.id !== bookmark.id);
    const lastPosition =
      readerState.lastPosition?.id === bookmark.position.id ? undefined : readerState.lastPosition;
    const activeSessionStart =
      readerState.activeSessionStart?.id === bookmark.position.id
        ? undefined
        : readerState.activeSessionStart;

    persist({
      ...readerState,
      activeSessionStart,
      lastPosition,
      bookmarks: nextBookmarks,
    });
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
    const nextRanges = [...readerState.readRanges, range];
    const workComplete =
      percentRead(
        currentWork,
        nextRanges.filter((candidate) => candidate.workId === currentWork.id),
      ) >= completedThreshold;
    const nextBookmarks = workComplete
      ? readerState.bookmarks.filter((item) => item.workId !== currentWork.id)
      : upsertPrimaryBookmark(readerState.bookmarks, bookmark);

    persist({
      ...readerState,
      activeSessionStart: undefined,
      lastPosition:
        workComplete
          ? readerState.lastPosition?.workId === currentWork.id
            ? undefined
            : readerState.lastPosition
          : currentPosition,
      readRanges: nextRanges,
      bookmarks: nextBookmarks,
    });
    setScreen("home");
  };

  const saveBookmark = () => {
    if (completedWorkIds.has(currentWork.id)) {
      setLoadingMessage("This sutra is already finished; progress remains saved.");
      return;
    }

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
          globalSegments={globalSegments}
          readerState={readerState}
          globalProgress={globalProgress}
          currentWorkProgress={progress}
          loadingMessage={loadingMessage}
          onOpenLibrary={() => setScreen("library")}
          onOpenOutline={() => setScreen("outline")}
          onContinue={() =>
            openReaderAt(primaryBookmark?.position ?? readerState.lastPosition ?? currentPosition)
          }
          onOpenGlobalSegment={(segment) =>
            openGlobalSegment(segment, globalProgress.workFractions, openCatalogItem)
          }
          onOpenBookmark={openBookmark}
          onDeleteBookmark={deleteBookmark}
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
          restoreKey={readerOpenKey}
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
  globalSegments,
  readerState,
  globalProgress,
  currentWorkProgress,
  loadingMessage,
  onOpenLibrary,
  onOpenOutline,
  onContinue,
  onOpenGlobalSegment,
  onOpenBookmark,
  onDeleteBookmark,
  onLoadDefault,
  onReset,
}: {
  theme: Theme;
  currentWork: SutraWork;
  globalSegments: GlobalProgressSegment[];
  readerState: ReaderState;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
  currentWorkProgress: number;
  loadingMessage?: string;
  onOpenLibrary: () => void;
  onOpenOutline: () => void;
  onContinue: () => void;
  onOpenGlobalSegment: (segment: GlobalProgressSegment) => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onLoadDefault: () => void;
  onReset: () => void;
}) {
  const activeBookmarks = readerState.bookmarks.filter(
    (bookmark) => (globalProgress.workFractions[bookmark.workId] ?? 0) < completedThreshold,
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.homeContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={[styles.appTitle, { color: theme.text }]}>Sutra Reader</Text>
          <Text style={[styles.subtitle, { color: theme.muted }]} numberOfLines={2}>
            Whole Sutra Sea
          </Text>
        </View>
        <Text style={[styles.percent, { color: theme.accent }]}>
          {formatPercent(globalProgress.percent)}
        </Text>
      </View>

      <Text style={[styles.catalogMeta, { color: theme.muted }]}>
        {globalProgress.completedWorks.toLocaleString()} of{" "}
        {cbetaCatalog.length.toLocaleString()} works completed. Current: {currentWork.title} (
        {Math.round(currentWorkProgress * 100)}%).
      </Text>

      <View style={styles.mapGrid}>
        {globalSegments.map((segment) => (
          <ProgressDot
            key={segment.id}
            theme={theme}
            fraction={globalSegmentFraction(segment, globalProgress.workFractions)}
            bookmarked={activeBookmarks.some((bookmark) =>
              isWorkInGlobalSegment(bookmark.workId, segment),
            )}
            label={segment.label}
            onPress={() => onOpenGlobalSegment(segment)}
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
        {activeBookmarks.slice(0, 4).map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            theme={theme}
            onOpen={onOpenBookmark}
            onDelete={onDeleteBookmark}
          />
        ))}
        {activeBookmarks.length === 0 ? (
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
    </ScrollView>
  );
}

function BookmarkRow({
  bookmark,
  theme,
  onOpen,
  onDelete,
}: {
  bookmark: Bookmark;
  theme: Theme;
  onOpen: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}) {
  const deleteWidth = 82;
  const translateX = useRef(new Animated.Value(0)).current;

  const close = () => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
    }).start();
  };

  const revealDelete = () => {
    Animated.spring(translateX, {
      toValue: -deleteWidth,
      useNativeDriver: true,
    }).start();
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_event, gesture) => {
          translateX.setValue(Math.max(-deleteWidth, Math.min(0, gesture.dx)));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx < -deleteWidth / 2) {
            revealDelete();
          } else {
            close();
          }
        },
        onPanResponderTerminate: close,
      }),
    [translateX],
  );

  return (
    <View style={[styles.bookmarkSwipeRow, { borderColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete bookmark ${bookmark.title}`}
        onPress={() => onDelete(bookmark)}
        style={[
          styles.bookmarkDeleteConfirm,
          { backgroundColor: theme.deleteBackground, width: deleteWidth },
        ]}
      >
        <Text style={[styles.bookmarkDeleteText, { color: theme.onDelete }]}>Delete</Text>
      </Pressable>
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          styles.bookmarkSwipeContent,
          { backgroundColor: theme.background, transform: [{ translateX }] },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open bookmark ${bookmark.title}`}
          onPress={() => {
            close();
            onOpen(bookmark);
          }}
          style={styles.bookmarkOpenTarget}
        >
          <Text style={[styles.bookmark, { color: theme.muted }]} numberOfLines={2}>
            {bookmark.title}
          </Text>
          <Text style={[styles.bookmarkAction, { color: theme.accent }]}>Open</Text>
        </Pressable>
      </Animated.View>
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
  onOpen: (item: CbetaCatalogItem, destination?: Screen) => void;
}) {
  const [query, setQuery] = useState("");
  const [cachedIds, setCachedIds] = useState<Record<string, boolean>>({});
  const filtered = useMemo(() => {
    const needle = normalizeSearchText(query);
    const items = needle
      ? cbetaCatalog.filter((item) =>
          (item.searchText ?? normalizeSearchText(catalogSearchText(item))).includes(needle),
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
        Showing {filtered.length} of {cbetaCatalog.length.toLocaleString()} works. Tap a sutra to
        open and cache it for offline reading.
      </Text>
      {loadingMessage ? (
        <Text style={[styles.loadingText, { color: theme.accent }]}>{loadingMessage}</Text>
      ) : null}
      <ScrollView showsVerticalScrollIndicator={false}>
        {filtered.map((item) => (
          <Pressable
            key={item.path}
            onPress={() => onOpen(item, "reader")}
            style={[styles.libraryRow, { borderColor: theme.border }]}
          >
            <View style={styles.libraryText}>
              <Text style={[styles.outlineTitle, { color: theme.text }]} numberOfLines={1}>
                {item.titleSimplified ?? item.title}
              </Text>
              <Text style={[styles.outlineMeta, { color: theme.muted }]} numberOfLines={1}>
                {item.canonTitleSimplified ?? item.canonTitle} - {item.volume} - {item.sourceId}
              </Text>
            </View>
            <Text style={[styles.cacheBadge, { color: theme.accent }]}>
              {cachedIds[item.id] ? "Read" : "Open"}
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
  restoreKey,
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
  restoreKey: number;
  readerState: ReaderState;
  onBack: () => void;
  onPositionChange: (position: ReadingPosition) => void;
  onStart: () => void;
  onMarkHere: () => void;
  onBookmark: () => void;
}) {
  const listRef = useRef<FlatList<SutraWork["blocks"][number]>>(null);
  const restoringRef = useRef(false);
  const targetBlockIndex = Math.max(
    0,
    work.blocks.findIndex((block) => block.id === position.textBlockId),
  );
  const estimatedLayouts = useMemo(() => createEstimatedBlockLayouts(work), [work]);
  const activeBlock = work.blocks.find((block) => block.id === position.textBlockId);
  const sessionActive = readerState.activeSessionStart?.workId === work.id;

  useEffect(() => {
    restoringRef.current = true;
    const timeout = setTimeout(() => {
      restoringRef.current = false;
    }, 350);

    return () => clearTimeout(timeout);
  }, [restoreKey, work.id]);

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title={work.title} onBack={onBack} />
      <Text style={[styles.readerSubhead, { color: theme.muted }]} numberOfLines={2}>
        {work.subtitle}
      </Text>

      <FlatList
        key={`${work.id}-${restoreKey}`}
        ref={listRef}
        data={work.blocks}
        keyExtractor={(block) => block.id}
        initialScrollIndex={targetBlockIndex}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={9}
        getItemLayout={(_data, index) => estimatedLayouts[index]}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: info.index,
              animated: false,
              viewPosition: 0.08,
            });
          }, 50);
        }}
        showsVerticalScrollIndicator={false}
        onScroll={(event) => {
          if (restoringRef.current) {
            return;
          }
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

function createEstimatedBlockLayouts(work: SutraWork) {
  const charsPerLine = 14;
  let offset = 0;

  return work.blocks.map((block, index) => {
    const textLines = Math.max(1, Math.ceil(block.textSimplified.length / charsPerLine));
    const titleHeight = block.title ? 30 : 0;
    const length = 20 + titleHeight + textLines * 42 + 10;
    const layout = { index, length, offset };
    offset += length;
    return layout;
  });
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

function createGlobalProgressSegments(segmentCount: number): GlobalProgressSegment[] {
  return Array.from({ length: segmentCount }, (_, index) => {
    const startIndex = Math.floor((cbetaCatalog.length * index) / segmentCount);
    const endIndex = Math.floor((cbetaCatalog.length * (index + 1)) / segmentCount);
    const first = cbetaCatalog[startIndex];
    const last = cbetaCatalog[Math.max(startIndex, endIndex - 1)];

    return {
      id: `global-${index}`,
      order: index,
      startIndex,
      endIndex: Math.max(startIndex + 1, endIndex),
      label: `${first?.canonTitle ?? "CBETA"} ${first?.sourceId ?? ""} - ${
        last?.sourceId ?? ""
      }`,
    };
  });
}

function calculateGlobalProgress(readRanges: ReaderState["readRanges"]) {
  const rangesByWork = new Map<string, Array<readonly [number, number]>>();
  const totalByWork = new Map<string, number>();

  for (const range of readRanges) {
    if (
      typeof range.startOffset !== "number" ||
      typeof range.endOffset !== "number" ||
      typeof range.workTotalChars !== "number" ||
      range.workTotalChars <= 0
    ) {
      continue;
    }

    const start = Math.max(0, Math.min(range.startOffset, range.endOffset));
    const end = Math.max(start, Math.max(range.startOffset, range.endOffset));
    const existing = rangesByWork.get(range.workId) ?? [];
    rangesByWork.set(range.workId, [...existing, [start, end]]);
    totalByWork.set(range.workId, range.workTotalChars);
  }

  const workFractions: Record<string, number> = {};
  let completedWorks = 0;
  let totalFraction = 0;

  for (const item of cbetaCatalog) {
    const ranges = rangesByWork.get(item.id) ?? [];
    const total = totalByWork.get(item.id) ?? 0;
    const fraction = total > 0 ? mergedIntervalLength(ranges) / total : 0;
    const safeFraction = Math.max(0, Math.min(fraction, 1));
    workFractions[item.id] = safeFraction;
    totalFraction += safeFraction;
    if (safeFraction >= 0.999) {
      completedWorks += 1;
    }
  }

  return {
    completedWorks,
    percent: totalFraction / cbetaCatalog.length,
    workFractions,
  };
}

function completedWorkIdsFromRanges(readRanges: ReaderState["readRanges"]) {
  const rangesByWork = new Map<string, Array<readonly [number, number]>>();
  const totalByWork = new Map<string, number>();

  for (const range of readRanges) {
    if (
      typeof range.startOffset !== "number" ||
      typeof range.endOffset !== "number" ||
      typeof range.workTotalChars !== "number" ||
      range.workTotalChars <= 0
    ) {
      continue;
    }

    const start = Math.max(0, Math.min(range.startOffset, range.endOffset));
    const end = Math.max(start, Math.max(range.startOffset, range.endOffset));
    const existing = rangesByWork.get(range.workId) ?? [];
    rangesByWork.set(range.workId, [...existing, [start, end]]);
    totalByWork.set(range.workId, range.workTotalChars);
  }

  const completed = new Set<string>();

  for (const [workId, ranges] of rangesByWork) {
    const total = totalByWork.get(workId) ?? 0;
    const fraction = total > 0 ? mergedIntervalLength(ranges) / total : 0;
    if (fraction >= completedThreshold) {
      completed.add(workId);
    }
  }

  return completed;
}

function mergedIntervalLength(intervals: Array<readonly [number, number]>) {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort(([a], [b]) => a - b);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;

  for (const [start, end] of sorted) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = start;
      currentEnd = end;
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }

  if (currentStart !== undefined && currentEnd !== undefined) {
    total += currentEnd - currentStart;
  }

  return total;
}

function globalSegmentFraction(
  segment: GlobalProgressSegment,
  workFractions: Record<string, number>,
) {
  const items = cbetaCatalog.slice(segment.startIndex, segment.endIndex);
  if (items.length === 0) {
    return 0;
  }

  const total = items.reduce((sum, item) => sum + (workFractions[item.id] ?? 0), 0);
  return total / items.length;
}

function isWorkInGlobalSegment(workId: string, segment: GlobalProgressSegment) {
  const index = catalogIndexById.get(workId);
  return index !== undefined && index >= segment.startIndex && index < segment.endIndex;
}

function openGlobalSegment(
  segment: GlobalProgressSegment,
  workFractions: Record<string, number>,
  openCatalogItem: (item: CbetaCatalogItem, destination?: Screen) => void,
) {
  const items = cbetaCatalog.slice(segment.startIndex, segment.endIndex);
  const target =
    items.find((item) => (workFractions[item.id] ?? 0) < 0.999) ?? items[0];

  if (target) {
    openCatalogItem(target, "reader");
  }
}

function formatPercent(value: number) {
  if (value > 0 && value < 0.001) {
    return "<0.1%";
  }

  return `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

function catalogSearchText(item: CbetaCatalogItem) {
  return [
    item.title,
    item.titleSimplified,
    item.canonTitle,
    item.canonTitleSimplified,
    item.sourceId,
    item.canon,
    item.volume,
    item.number,
    item.path,
  ]
    .filter(Boolean)
    .join(" ");
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

function normalizeReaderState(state: ReaderState): ReaderState {
  const completedWorkIds = completedWorkIdsFromRanges(state.readRanges);

  return {
    ...state,
    activeSessionStart:
      state.activeSessionStart && completedWorkIds.has(state.activeSessionStart.workId)
        ? undefined
        : state.activeSessionStart,
    bookmarks: normalizeBookmarks(state.bookmarks, completedWorkIds),
  };
}

function normalizeBookmarks(bookmarks: Bookmark[], completedWorkIds: Set<string>) {
  const seenIds = new Set<string>();
  const seenPrimaryWorks = new Set<string>();
  const normalized: Bookmark[] = [];

  for (const bookmark of bookmarks) {
    if (seenIds.has(bookmark.id) || completedWorkIds.has(bookmark.workId)) {
      continue;
    }

    seenIds.add(bookmark.id);

    if (bookmark.isPrimaryForWork) {
      if (seenPrimaryWorks.has(bookmark.workId)) {
        continue;
      }
      seenPrimaryWorks.add(bookmark.workId);
    }

    normalized.push(bookmark);
  }

  return normalized.slice(0, 80);
}

function upsertPrimaryBookmark(bookmarks: Bookmark[], bookmark: Bookmark) {
  return [
    bookmark,
    ...bookmarks
      .filter((item) => !(item.workId === bookmark.workId && item.isPrimaryForWork))
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
  deleteBackground: "#b42318",
  onDelete: "#fffaf0",
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
  deleteBackground: "#d92d20",
  onDelete: "#fffaf0",
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
  homeContent: {
    paddingBottom: 18,
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
    maxWidth: 336,
    rowGap: 5,
  },
  dotHit: {
    alignItems: "center",
    borderRadius: 8,
    height: 24,
    justifyContent: "center",
    marginHorizontal: 2,
    width: 24,
  },
  dot: {
    borderRadius: 4,
    height: 9,
    width: 9,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 22,
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
    flex: 1,
    fontSize: 15,
    lineHeight: 24,
  },
  bookmarkSwipeRow: {
    borderBottomWidth: 1,
    minHeight: 44,
    overflow: "hidden",
    position: "relative",
  },
  bookmarkSwipeContent: {
    minHeight: 60,
    justifyContent: "center",
    paddingVertical: 8,
  },
  bookmarkOpenTarget: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 44,
  },
  bookmarkAction: {
    fontSize: 13,
    fontWeight: "700",
  },
  bookmarkDeleteConfirm: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    top: 0,
  },
  bookmarkDeleteText: {
    fontSize: 13,
    fontWeight: "700",
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
