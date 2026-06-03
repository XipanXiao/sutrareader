import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
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
import { loadReaderState, saveReaderState } from "./src/lib/storage";
import {
  Bookmark,
  CbetaCatalogItem,
  ReaderState,
  ReadingPosition,
  SutraWork,
} from "./src/types";

type Screen = "home" | "library" | "outline" | "reader";
type Theme = typeof lightTheme;
type ReaderTextItem = {
  id: string;
  block: SutraWork["blocks"][number];
  text: string;
  charStart: number;
  charEnd: number;
  title?: string;
};
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
      !bookmark.isCompletionAnchor &&
      bookmark.workId === currentWork.id &&
      !completedWorkIds.has(bookmark.workId),
  );
  const progress = percentRead(currentWork, workRanges);
  const globalProgress = useMemo(
    () => calculateGlobalProgress(readerState.readRanges),
    [readerState.readRanges],
  );
  const globalSegments = useMemo(() => createGlobalProgressSegments(144), []);
  const primaryBookmark =
    workBookmarks.find((bookmark) => bookmark.isPrimaryForWork) ?? workBookmarks[0];
  const latestBookmark = readerState.completionAnchor ?? readerState.bookmarks[0];
  const nextCatalogItem = useMemo(() => {
    const index = catalogIndexForWork(currentWork);
    if (index === undefined || index >= cbetaCatalog.length - 1) {
      return undefined;
    }

    return cbetaCatalog[index + 1];
  }, [currentWork]);

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

  const openReaderAt = async (position: ReadingPosition) => {
    setLoadingMessage(`正在打开《${currentWork.title}》`);
    await waitForLoadingPaint();
    setCurrentPosition(position);
    persist({ ...readerState, lastPosition: position });
    setReaderOpenKey((value) => value + 1);
    setScreen("reader");
    setTimeout(() => setLoadingMessage(undefined), 120);
  };

  const openCatalogItem = async (
    item: CbetaCatalogItem,
    destination: Screen = "home",
    stateOverride?: ReaderState,
    positionOverride?: ReadingPosition,
  ) => {
    const baseState = stateOverride ?? readerState;
    setLoadingMessage(`正在载入《${item.titleSimplified ?? item.title}》`);
    try {
      await waitForLoadingPaint();
      const work = await loadCbetaWork(item);
      setCurrentWork(work);
      const bookmark = baseState.bookmarks.find(
        (candidate) => !candidate.isCompletionAnchor && candidate.workId === work.id,
      );
      const start = positionOverride ?? bookmark?.position ?? offsetToPosition(work, 0);
      setCurrentPosition(start);
      persist({ ...baseState, lastPosition: start });
      if (destination === "reader") {
        setReaderOpenKey((value) => value + 1);
      }
      setScreen(destination);
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "无法载入这部 CBETA 文献",
      );
      return;
    }
    setTimeout(() => setLoadingMessage(undefined), 120);
  };

  const openBookmark = async (bookmark: Bookmark) => {
    if (
      bookmark.workId === currentWork.id ||
      bookmark.position.workId === currentWork.id ||
      currentWork.blocks.some((block) => block.id === bookmark.position.textBlockId)
    ) {
      openReaderAt(positionForBookmarkInWork(bookmark, currentWork));
      return;
    }

    const item = catalogItemForBookmark(bookmark);
    if (!item) {
      setLoadingMessage("无法在经藏中找到这个书签对应的经文");
      return;
    }

    setLoadingMessage(`正在载入《${item.titleSimplified ?? item.title}》`);
    try {
      await waitForLoadingPaint();
      const work = await loadCbetaWork(item);
      const position = positionForBookmarkInWork(bookmark, work);
      setCurrentWork(work);
      setCurrentPosition(position);
      persist({ ...readerState, lastPosition: position });
      setReaderOpenKey((value) => value + 1);
      setScreen("reader");
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "无法载入这个书签对应的经文",
      );
      return;
    }
    setTimeout(() => setLoadingMessage(undefined), 120);
  };

  const deleteBookmark = (bookmark: Bookmark) => {
    if (readerState.completionAnchor?.id === bookmark.id) {
      persist({
        ...readerState,
        completionAnchor: undefined,
        lastPosition:
          readerState.lastPosition?.id === bookmark.position.id
            ? undefined
            : readerState.lastPosition,
      });
      return;
    }

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

  const saveProgressAt = (
    position: ReadingPosition,
    returnHome: boolean,
    completeCurrentWork = false,
  ) => {
    const positionIsAtEnd = isEndPosition(currentWork, position);
    const shouldCompleteWork = completeCurrentWork || positionIsAtEnd;
    const start = shouldCompleteWork
      ? offsetToPosition(currentWork, 0, 0)
      : primaryBookmark?.position ?? position;
    const range = createReadRange(currentWork, start, position);
    const bookmark = createBookmark(currentWork, position, true);
    const completionAnchor = {
      ...bookmark,
      title: `已完成至此 - ${bookmark.title}`,
      isCompletionAnchor: true,
    };
    const nextRanges = [...readerState.readRanges, range];
    const workComplete =
      shouldCompleteWork ||
      percentRead(
        currentWork,
        nextRanges.filter((candidate) => candidate.workId === currentWork.id),
      ) >= completedThreshold;
    const nextBookmarks =
      workComplete
        ? readerState.bookmarks.filter((item) => item.workId !== currentWork.id)
        : upsertPrimaryBookmark(readerState.bookmarks, bookmark);

    const nextState = {
      ...readerState,
      activeSessionStart: undefined,
      completionAnchor: workComplete ? completionAnchor : undefined,
      lastPosition: position,
      readRanges: nextRanges,
      bookmarks: nextBookmarks,
    };

    persist(nextState);

    if (returnHome) {
      setScreen("home");
    }

    return normalizeReaderState(nextState);
  };

  const markHere = () => {
    saveProgressAt(currentPosition, true, false);
  };

  const openNextWork = () => {
    if (!nextCatalogItem) {
      return;
    }

    const nextState = saveProgressAt(
      offsetToPosition(currentWork, totalChars(currentWork), 1),
      false,
      true,
    );
    openCatalogItem(nextCatalogItem, "reader", nextState);
  };

  const exportProgress = async () => {
    const fileName = `yuezang-progress-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    const fileUri = `${FileSystem.cacheDirectory ?? ""}${fileName}`;
    const payload = {
      app: "阅藏",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      state: normalizeReaderState(readerState),
    };

    try {
      await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(payload, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          dialogTitle: "导出阅藏进度",
          mimeType: "application/json",
          UTI: "public.json",
        });
      } else {
        Alert.alert("已导出", `进度文件已保存到：${fileUri}`);
      }
    } catch (error) {
      Alert.alert(
        "导出失败",
        error instanceof Error ? error.message : "无法导出进度文件",
      );
    }
  };

  const importProgress = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "text/json", "public.json"],
        copyToCacheDirectory: true,
      });

      if (picked.canceled) {
        return;
      }

      const uri = picked.assets[0]?.uri;
      if (!uri) {
        Alert.alert("导入失败", "没有选择进度文件");
        return;
      }

      const raw = await FileSystem.readAsStringAsync(uri);
      const parsed = JSON.parse(raw);
      const importedState = parseImportedReaderState(parsed);
      const nextState = normalizeReaderState(mergeReaderStates(readerState, importedState));
      persist(nextState);
      Alert.alert("导入完成", "进度和书签已合并到本机。");
    } catch (error) {
      Alert.alert(
        "导入失败",
        error instanceof Error ? error.message : "无法读取这个进度文件",
      );
    }
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
          onOpenLibrary={() => setScreen("library")}
          onOpenOutline={() => setScreen("outline")}
          onContinue={() =>
            latestBookmark
              ? openBookmark(latestBookmark)
              : openReaderAt(readerState.lastPosition ?? currentPosition)
          }
          onOpenGlobalSegment={(segment) =>
            readerState.completionAnchor &&
            isWorkInGlobalSegment(readerState.completionAnchor.workId, segment)
              ? openBookmark(readerState.completionAnchor)
              : openGlobalSegment(
                  segment,
                  globalProgress.workFractions,
                  readerState.readRanges,
                  openCatalogItem,
                  setLoadingMessage,
                )
          }
          onOpenBookmark={openBookmark}
          onDeleteBookmark={deleteBookmark}
          onExportProgress={exportProgress}
          onImportProgress={importProgress}
          onLoadDefault={() => openCatalogItem(defaultCatalogItem)}
        />
      ) : null}
      {screen === "library" ? (
        <LibraryScreen
          theme={theme}
          globalProgress={globalProgress}
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
          progress={progress}
          restoreKey={readerOpenKey}
          onBack={() => setScreen("home")}
          onPositionChange={(position) => {
            setCurrentPosition(position);
            setReaderState((state) => {
              const nextState = { ...state, lastPosition: position };
              saveReaderState(nextState);
              return nextState;
            });
          }}
          onMarkHere={markHere}
          nextWorkTitle={nextCatalogItem?.titleSimplified ?? nextCatalogItem?.title}
          onOpenNextWork={openNextWork}
        />
      ) : null}
      <LoadingOverlay theme={theme} message={loadingMessage} />
    </SafeAreaView>
  );
}

function LoadingOverlay({ theme, message }: { theme: Theme; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <View style={styles.loadingOverlay} pointerEvents="auto">
      <View
        style={[
          styles.loadingCard,
          { backgroundColor: theme.input, borderColor: theme.border },
        ]}
      >
        <ActivityIndicator color={theme.accent} size="small" />
        <Text style={[styles.loadingOverlayText, { color: theme.text }]}>
          {message}
        </Text>
      </View>
    </View>
  );
}

function HomeScreen({
  theme,
  currentWork,
  globalSegments,
  readerState,
  globalProgress,
  currentWorkProgress,
  onOpenLibrary,
  onOpenOutline,
  onContinue,
  onOpenGlobalSegment,
  onOpenBookmark,
  onDeleteBookmark,
  onExportProgress,
  onImportProgress,
  onLoadDefault,
}: {
  theme: Theme;
  currentWork: SutraWork;
  globalSegments: GlobalProgressSegment[];
  readerState: ReaderState;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
  currentWorkProgress: number;
  onOpenLibrary: () => void;
  onOpenOutline: () => void;
  onContinue: () => void;
  onOpenGlobalSegment: (segment: GlobalProgressSegment) => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onExportProgress: () => void;
  onImportProgress: () => void;
  onLoadDefault: () => void;
}) {
  const activeBookmarks = readerState.bookmarks.filter(
    (bookmark) =>
      !bookmark.isCompletionAnchor &&
      (globalProgress.workFractions[bookmark.workId] ?? 0) < completedThreshold,
  );
  const visibleBookmarks = readerState.completionAnchor
    ? [readerState.completionAnchor, ...activeBookmarks]
    : activeBookmarks;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.homeContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={[styles.appTitle, { color: theme.text }]}>阅藏</Text>
          <Text style={[styles.subtitle, { color: theme.muted }]} numberOfLines={2}>
            深入经藏，智慧如海
          </Text>
        </View>
        <Text style={[styles.percent, { color: theme.accent }]}>
          {formatPercent(globalProgress.percent)}
        </Text>
      </View>

      <Text style={[styles.catalogMeta, { color: theme.muted }]}>
        已读完 {globalProgress.completedWorks.toLocaleString()} /{" "}
        {cbetaCatalog.length.toLocaleString()} 部。当前：{currentWork.title}（
        {Math.round(currentWorkProgress * 100)}%）。
      </Text>

      <View style={styles.mapGrid}>
        {globalSegments.map((segment) => (
          <ProgressDot
            key={segment.id}
            theme={theme}
            fraction={globalSegmentFraction(segment, globalProgress.workFractions)}
            bookmarked={visibleBookmarks.some((bookmark) =>
              isWorkInGlobalSegment(bookmark.workId, segment),
            )}
            label={segment.label}
            onPress={() => onOpenGlobalSegment(segment)}
          />
        ))}
      </View>

      <View style={styles.actionRow}>
        <Button label="继续" theme={theme} filled onPress={onContinue} />
        <Button label="经藏" theme={theme} onPress={onOpenLibrary} />
        <Button label="目录" theme={theme} onPress={onOpenOutline} />
        <CompactButton
          label="导出进度"
          text="导出"
          theme={theme}
          onPress={onExportProgress}
        />
        <CompactButton
          label="导入进度"
          text="导入"
          theme={theme}
          onPress={onImportProgress}
        />
      </View>

      {currentWork.id === sampleSutra.id ? (
        <Pressable onPress={onLoadDefault} style={styles.notice}>
          <Text style={[styles.noticeText, { color: theme.accent }]}>
            下载第一部 CBETA 文献以替换示例内容。
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.panel}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>书签</Text>
        <ScrollView
          nestedScrollEnabled
          showsVerticalScrollIndicator={visibleBookmarks.length > 4}
          style={visibleBookmarks.length > 4 ? styles.bookmarkList : null}
        >
          {visibleBookmarks.map((bookmark) => (
            <BookmarkRow
              key={bookmark.id}
              bookmark={bookmark}
              theme={theme}
              onOpen={onOpenBookmark}
              onDelete={onDeleteBookmark}
            />
          ))}
        </ScrollView>
        {visibleBookmarks.length === 0 ? (
          <Text style={[styles.bookmark, { color: theme.muted }]}>暂无书签</Text>
        ) : null}
      </View>

      {currentWork.sourceAttribution ? (
        <Text style={[styles.sourceText, { color: theme.muted }]}>
          {currentWork.sourceAttribution}
        </Text>
      ) : null}
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
  const deleteWidth = 96;
  const translateX = useRef(new Animated.Value(0)).current;
  const startOffset = useRef(0);
  const currentOffset = useRef(0);
  const revealed = useRef(false);

  const animateTo = (value: number) => {
    currentOffset.current = value;
    revealed.current = value < 0;
    Animated.spring(translateX, {
      toValue: value,
      useNativeDriver: true,
    }).start();
  };

  const close = () => animateTo(0);

  const revealDelete = () => {
    animateTo(-deleteWidth);
  };

  const shouldClaimHorizontalSwipe = (dx: number, dy: number) =>
    Math.abs(dx) > 2 && Math.abs(dx) > Math.abs(dy) * 1.15;

  const settleSwipe = (dx: number, vx: number) => {
    const leftFlick = vx < -0.02 || dx < -3;
    const rightFlick = vx > 0.08 || dx > 12;
    const shouldReveal =
      leftFlick || currentOffset.current <= -deleteWidth * 0.08;

    if (revealed.current && rightFlick) {
      close();
      return;
    }

    if (shouldReveal) {
      revealDelete();
      return;
    }

    close();
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          shouldClaimHorizontalSwipe(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) =>
          shouldClaimHorizontalSwipe(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          startOffset.current = currentOffset.current;
          translateX.stopAnimation();
        },
        onPanResponderMove: (_event, gesture) => {
          const nextOffset = Math.max(
            -deleteWidth,
            Math.min(0, startOffset.current + gesture.dx),
          );
          currentOffset.current = nextOffset;
          if (nextOffset < -2) {
            revealed.current = true;
          }
          translateX.setValue(nextOffset);
        },
        onPanResponderRelease: (_event, gesture) => {
          settleSwipe(gesture.dx, gesture.vx);
        },
        onPanResponderTerminationRequest: () => {
          return false;
        },
        onPanResponderTerminate: () => {
          settleSwipe(currentOffset.current - startOffset.current, 0);
        },
      }),
    [translateX],
  );

  return (
    <View style={[styles.bookmarkSwipeRow, { borderColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`删除书签 ${bookmark.title}`}
        onPress={() => onDelete(bookmark)}
        style={[
          styles.bookmarkDeleteConfirm,
          { backgroundColor: theme.deleteBackground, width: deleteWidth },
        ]}
      >
        <Text style={[styles.bookmarkDeleteText, { color: theme.onDelete }]}>删除</Text>
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
          accessibilityLabel={`打开书签 ${bookmark.title}`}
          onPress={() => {
            if (revealed.current) {
              close();
              return;
            }
            close();
            onOpen(bookmark);
          }}
          style={styles.bookmarkOpenTarget}
        >
          <Text style={[styles.bookmark, { color: theme.muted }]} numberOfLines={2}>
            {bookmark.title}
          </Text>
          <Text style={[styles.bookmarkAction, { color: theme.accent }]}>打开</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function LibraryScreen({
  theme,
  globalProgress,
  onBack,
  onOpen,
}: {
  theme: Theme;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
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
      <TopBar theme={theme} title="CBETA 经藏" onBack={onBack} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="搜索经名、藏经或编号"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        style={[
          styles.searchInput,
          { borderColor: theme.border, color: theme.text, backgroundColor: theme.input },
        ]}
      />
      <Text style={[styles.catalogMeta, { color: theme.muted }]}>
        显示 {filtered.length} / {cbetaCatalog.length.toLocaleString()} 部。轻点经文即可打开并离线缓存。
      </Text>
      <ScrollView showsVerticalScrollIndicator={false}>
        {filtered.map((item) => (
          <LibraryRow
            key={item.path}
            item={item}
            cached={Boolean(cachedIds[item.id])}
            progress={globalProgress.workFractions[item.id] ?? 0}
            theme={theme}
            onOpen={() => onOpen(item, "reader")}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function LibraryRow({
  item,
  cached,
  progress,
  theme,
  onOpen,
}: {
  item: CbetaCatalogItem;
  cached: boolean;
  progress: number;
  theme: Theme;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onPress={onOpen}
      style={[styles.libraryRow, { borderColor: theme.border }]}
    >
      <View style={styles.libraryText}>
        <Text style={[styles.outlineTitle, { color: theme.text }]} numberOfLines={1}>
          {item.titleSimplified ?? item.title}
        </Text>
        <Text style={[styles.outlineMeta, { color: theme.muted }]} numberOfLines={1}>
          {item.canonTitleSimplified ?? item.canonTitle} - {item.volume} - {item.sourceId}
        </Text>
        <View style={styles.libraryProgressRow}>
          <WorkProgressBadge theme={theme} progress={progress} />
          <MiniBar theme={theme} fraction={progress} compact />
        </View>
      </View>
      <Text style={[styles.cacheBadge, { color: theme.accent }]}>
        {cached ? "阅读" : "打开"}
      </Text>
    </Pressable>
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
      <TopBar theme={theme} title="目录" onBack={onBack} />
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
                  {section.blockIds.length} 段 · 已读 {Math.round(fraction * 100)}%
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
  progress,
  restoreKey,
  onBack,
  onPositionChange,
  onMarkHere,
  nextWorkTitle,
  onOpenNextWork,
}: {
  theme: Theme;
  work: SutraWork;
  position: ReadingPosition;
  progress: number;
  restoreKey: number;
  onBack: () => void;
  onPositionChange: (position: ReadingPosition) => void;
  onMarkHere: () => void;
  nextWorkTitle?: string;
  onOpenNextWork: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const restoringRef = useRef(true);
  const readerItems = useMemo(() => createReaderTextItems(work), [work]);
  const targetItem =
    readerItems.find(
      (item) =>
        item.block.id === position.textBlockId &&
        position.charOffset >= item.charStart &&
        position.charOffset <= item.charEnd,
    ) ?? readerItems[0];
  const activeBlock = work.blocks.find((block) => block.id === position.textBlockId);
  const workRef = useRef(work);
  const onPositionChangeRef = useRef(onPositionChange);
  const itemLayoutsRef = useRef<Record<string, { y: number; height: number }>>({});
  const readerItemsRef = useRef(readerItems);
  const restoreKeyRef = useRef("");
  const restorePositionRef = useRef(position);
  const restoreSuccessCountRef = useRef(0);
  const targetItemRef = useRef(targetItem);
  const lastReportedItemRef = useRef("");
  const approximateRestoreFiredRef = useRef(false);

  useEffect(() => {
    workRef.current = work;
    onPositionChangeRef.current = onPositionChange;
    readerItemsRef.current = readerItems;
    targetItemRef.current = targetItem;
  }, [onPositionChange, readerItems, targetItem, work]);

  useEffect(() => {
    restoringRef.current = true;
    restoreKeyRef.current = `${work.id}-${restoreKey}-${position.id}`;
    restorePositionRef.current = position;
    restoreSuccessCountRef.current = 0;
    approximateRestoreFiredRef.current = false;
    itemLayoutsRef.current = {};
    lastReportedItemRef.current = "";
    
    const retry = setInterval(() => {
      const item = targetItemRef.current;
      if (item) {
        restoreToItem(item);
      }
    }, 120);
    
    // Increase timeout to 15 seconds to allow more time for rendering
    // and ensure approximate fallback has a chance to work
    const timeout = setTimeout(() => {
      clearInterval(retry);
      restoreKeyRef.current = "";
      restoreSuccessCountRef.current = 0;
      restoringRef.current = false;
    }, 15000);

    return () => {
      clearInterval(retry);
      clearTimeout(timeout);
    };
  }, [position.id, restoreKey, work.id]);

  const restoreToItem = (item: ReaderTextItem) => {
    const layout = itemLayoutsRef.current[item.id];
    if (!layout || restoreKeyRef.current === "") {
      return;
    }

    const restorePosition = restorePositionRef.current;
    const ratio = Math.max(
      0,
      Math.min(
        (restorePosition.charOffset - item.charStart) /
          Math.max(1, item.charEnd - item.charStart),
        1,
      ),
    );
    const y = Math.max(0, layout.y + layout.height * ratio - 18);
    scrollRef.current?.scrollTo({ y, animated: false });
    restoreSuccessCountRef.current += 1;

    // Reduce success count threshold to 3 for more responsive restoration
    if (restoreSuccessCountRef.current >= 3) {
      restoreKeyRef.current = "";
      restoringRef.current = false;
    }
  };

  const restoreApproximately = (contentHeight: number) => {
    // Only fire once and only if precise restoration hasn't started
    if (
      approximateRestoreFiredRef.current ||
      restoreKeyRef.current === "" ||
      restoreSuccessCountRef.current > 0
    ) {
      return;
    }

    const restorePosition = restorePositionRef.current;
    if (restorePosition.scrollFraction <= 0) {
      return;
    }

    approximateRestoreFiredRef.current = true;
    scrollRef.current?.scrollTo({
      y: Math.max(0, contentHeight * restorePosition.scrollFraction - 32),
      animated: false,
    });
  };

  const reportVisiblePosition = (scrollY: number) => {
    if (restoringRef.current) {
      return;
    }

    const anchorY = scrollY + 28;
    const item = readerItemsRef.current.find((candidate) => {
      const layout = itemLayoutsRef.current[candidate.id];
      return layout && layout.y + layout.height >= anchorY;
    });
    const layout = item ? itemLayoutsRef.current[item.id] : undefined;

    if (!item || !layout || item.id === lastReportedItemRef.current) {
      return;
    }

    lastReportedItemRef.current = item.id;
    const currentWork = workRef.current;
    const chars = totalChars(currentWork);
    const ratio = Math.max(0, Math.min((anchorY - layout.y) / Math.max(1, layout.height), 1));
    const charOffset = Math.floor(
      item.charStart + (item.charEnd - item.charStart) * ratio,
    );
    const absoluteOffset = positionToOffset(
      currentWork,
      makePosition(currentWork.id, item.block, charOffset, 0),
    );

    onPositionChangeRef.current(
      makePosition(
        currentWork.id,
        item.block,
        charOffset,
        chars > 0 ? absoluteOffset / chars : 0,
      ),
    );
  };

  return (
    <View style={styles.screen}>
      <TopBar
        theme={theme}
        title={work.title}
        onBack={onBack}
        rightAction={
          <Pressable onPress={onMarkHere} style={styles.topActionButton}>
            <Text style={[styles.topActionText, { color: theme.accent }]}>记到此处</Text>
          </Pressable>
        }
      />
      <Text style={[styles.readerSubhead, { color: theme.muted }]} numberOfLines={2}>
        {work.subtitle}
      </Text>
      <View style={styles.readerProgressRow}>
        <WorkProgressBadge theme={theme} progress={progress} />
        <MiniBar theme={theme} fraction={progress} />
      </View>

      <ScrollView
        key={`${work.id}-${restoreKey}`}
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        onScroll={(event) => reportVisiblePosition(event.nativeEvent.contentOffset.y)}
        onContentSizeChange={(_width, height) => restoreApproximately(height)}
        scrollEventThrottle={250}
        style={styles.readerScroll}
      >
        {readerItems.map((item) => (
          <Pressable
            key={item.id}
            onLayout={(event) => {
              itemLayoutsRef.current[item.id] = event.nativeEvent.layout;
              if (item.id === targetItem?.id) {
                restoreToItem(item);
              }
            }}
            onPress={() =>
              onPositionChange(
                makePosition(
                  work.id,
                  item.block,
                  Math.floor((item.charStart + item.charEnd) / 2),
                  position.scrollFraction,
                ),
              )
            }
            style={[
              styles.readerBlock,
              activeBlock?.id === item.block.id
                ? { backgroundColor: theme.selection }
                : { backgroundColor: "transparent" },
            ]}
          >
            {item.title ? (
              <Text style={[styles.blockTitle, { color: theme.accent }]}>{item.title}</Text>
            ) : null}
            <Text style={[styles.readerText, { color: theme.text }]}>
              {item.text}
            </Text>
          </Pressable>
        ))}
        <View style={[styles.readerEndPanel, { borderColor: theme.border }]}>
          <Text style={[styles.readerEndTitle, { color: theme.text }]}>
            已到本部末尾
          </Text>
          {nextWorkTitle ? (
            <Text style={[styles.readerEndMeta, { color: theme.muted }]} numberOfLines={2}>
              下一部：{nextWorkTitle}
            </Text>
          ) : (
            <Text style={[styles.readerEndMeta, { color: theme.muted }]}>
              已到经藏末尾
            </Text>
          )}
          <View style={styles.readerEndActions}>
            {nextWorkTitle ? (
              <Button label="下一部" theme={theme} filled onPress={onOpenNextWork} />
            ) : null}
          </View>
        </View>
      </ScrollView>
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
      accessibilityLabel={`${label}，已读 ${Math.round(fraction * 100)}%`}
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

function createReaderTextItems(work: SutraWork): ReaderTextItem[] {
  return work.blocks.flatMap((block) => {
    const chunks = splitReaderText(block.textSimplified);
    let charStart = 0;

    return chunks.map((text, index) => {
      const item: ReaderTextItem = {
        id: `${block.id}-chunk-${index}`,
        block,
        text,
        charStart,
        charEnd: charStart + text.length,
        title: index === 0 ? block.title : undefined,
      };
      charStart = item.charEnd;
      return item;
    });
  });
}

function splitReaderText(text: string, targetLength = 260) {
  if (text.length <= targetLength) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + targetLength);

    if (end < text.length) {
      const windowStart = Math.min(end - 1, start + Math.floor(targetLength * 0.55));
      const slice = text.slice(windowStart, end);
      const punctuationIndex = Math.max(
        slice.lastIndexOf("。"),
        slice.lastIndexOf("；"),
        slice.lastIndexOf("！"),
        slice.lastIndexOf("？"),
      );

      if (punctuationIndex >= 0) {
        end = windowStart + punctuationIndex + 1;
      }
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
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

function CompactButton({
  label,
  text,
  theme,
  onPress,
}: {
  label: string;
  text: string;
  theme: Theme;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.compactButton, { borderColor: theme.border }]}
    >
      <Text style={[styles.compactButtonText, { color: theme.text }]}>{text}</Text>
    </Pressable>
  );
}

function TopBar({
  theme,
  title,
  onBack,
  rightAction,
}: {
  theme: Theme;
  title: string;
  onBack: () => void;
  rightAction?: React.ReactNode;
}) {
  return (
    <View style={styles.topBar}>
      <Pressable onPress={onBack} style={styles.backButton}>
        <Text style={[styles.backText, { color: theme.accent }]}>返回</Text>
      </Pressable>
      <Text style={[styles.topTitle, { color: theme.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.topRightSlot}>{rightAction}</View>
    </View>
  );
}

function WorkProgressBadge({
  theme,
  progress,
}: {
  theme: Theme;
  progress: number;
}) {
  const complete = progress >= completedThreshold;
  const started = progress > 0;
  const label = complete
    ? "已完成"
    : started
      ? `已读 ${formatPercent(progress)}`
      : "未读";
  const color = complete ? theme.complete : started ? theme.accent : theme.muted;
  const borderColor = complete ? theme.complete : theme.border;

  return (
    <View style={[styles.workProgressBadge, { borderColor }]}>
      <Text style={[styles.workProgressText, { color }]}>{label}</Text>
    </View>
  );
}

function MiniBar({
  theme,
  fraction,
  compact = false,
}: {
  theme: Theme;
  fraction: number;
  compact?: boolean;
}) {
  const complete = fraction >= completedThreshold;
  return (
    <View
      style={[
        styles.miniBar,
        compact ? styles.miniBarCompact : null,
        { backgroundColor: theme.dot },
      ]}
    >
      <View
        style={[
          styles.miniBarFill,
          {
            backgroundColor: complete ? theme.complete : theme.accent,
            width: `${Math.round(fraction * 100)}%`,
          },
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

function catalogIndexForWork(work: SutraWork) {
  const directIndex = catalogIndexById.get(work.id);
  if (directIndex !== undefined) {
    return directIndex;
  }

  if (work.sourcePath) {
    const index = cbetaCatalog.findIndex((item) => item.path === work.sourcePath);
    if (index >= 0) {
      return index;
    }
  }

  if (work.sourceUrl) {
    const index = cbetaCatalog.findIndex((item) => item.rawUrl === work.sourceUrl);
    if (index >= 0) {
      return index;
    }
  }

  const text = `${work.id} ${work.subtitle} ${work.blocks[0]?.workId ?? ""} ${
    work.blocks[0]?.id ?? ""
  }`;
  const index = cbetaCatalog.findIndex((item) => text.includes(item.sourceId));
  if (index >= 0) {
    return index;
  }

  return undefined;
}

function catalogItemForBookmark(bookmark: Bookmark) {
  const direct =
    cbetaCatalog.find((item) => item.id === bookmark.workId) ??
    cbetaCatalog.find((item) => item.id === bookmark.position.workId);
  if (direct) {
    return direct;
  }

  const bookmarkText = normalizeSearchText(
    [
      bookmark.workId,
      bookmark.position.workId,
      bookmark.position.textBlockId,
      bookmark.position.anchorId,
      bookmark.title,
    ].join(" "),
  );

  const sourceMatch = cbetaCatalog.find((item) =>
    bookmarkText.includes(normalizeSearchText(item.sourceId)),
  );
  if (sourceMatch) {
    return sourceMatch;
  }

  return cbetaCatalog.find((item) => {
    const title = normalizeSearchText(item.titleSimplified ?? item.title);
    return title.length > 0 && (bookmarkText.includes(title) || title.includes(bookmarkText));
  });
}

function positionForBookmarkInWork(bookmark: Bookmark, work: SutraWork): ReadingPosition {
  const block = work.blocks.find((item) => item.id === bookmark.position.textBlockId);
  if (!block) {
    return offsetToPosition(work, 0);
  }

  return {
    ...bookmark.position,
    workId: work.id,
    textBlockId: block.id,
    anchorId: block.anchorId,
    charOffset: Math.max(
      0,
      Math.min(bookmark.position.charOffset, block.textSimplified.length),
    ),
  };
}

function openGlobalSegment(
  segment: GlobalProgressSegment,
  workFractions: Record<string, number>,
  readRanges: ReaderState["readRanges"],
  openCatalogItem: (
    item: CbetaCatalogItem,
    destination?: Screen,
    stateOverride?: ReaderState,
    positionOverride?: ReadingPosition,
  ) => void,
  setLoadingMessage?: (message: string | undefined) => void,
) {
  const items = cbetaCatalog.slice(segment.startIndex, segment.endIndex);
  const target =
    items.find((item) => (workFractions[item.id] ?? 0) < 0.999) ?? items[0];

  if (target) {
    setLoadingMessage?.(`正在载入《${target.titleSimplified ?? target.title}》`);
    waitForLoadingPaint().then(() => loadCbetaWork(target)).then((work) => {
      openCatalogItem(
        target,
        "reader",
        undefined,
        firstUnreadPosition(
          work,
          readRanges.filter((range) => range.workId === work.id),
        ),
      );
    });
  }
}

function waitForLoadingPaint() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
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

function parseImportedReaderState(value: unknown): ReaderState {
  const maybePayload = value as { state?: unknown };
  const maybeState = (maybePayload.state ?? value) as Partial<ReaderState>;

  if (!maybeState || !Array.isArray(maybeState.readRanges)) {
    throw new Error("这不是有效的阅藏进度文件");
  }

  return {
    bookmarks: Array.isArray(maybeState.bookmarks) ? maybeState.bookmarks : [],
    completionAnchor: maybeState.completionAnchor,
    readRanges: maybeState.readRanges,
    activeSessionStart: maybeState.activeSessionStart,
    lastPosition: maybeState.lastPosition,
  };
}

function mergeReaderStates(local: ReaderState, incoming: ReaderState): ReaderState {
  return {
    bookmarks: mergeBookmarks(local.bookmarks, incoming.bookmarks),
    completionAnchor: newerBookmark(local.completionAnchor, incoming.completionAnchor),
    readRanges: mergeReadRanges(local.readRanges, incoming.readRanges),
    activeSessionStart: newerPosition(local.activeSessionStart, incoming.activeSessionStart),
    lastPosition: newerPosition(local.lastPosition, incoming.lastPosition),
  };
}

function mergeReadRanges(
  local: ReaderState["readRanges"],
  incoming: ReaderState["readRanges"],
) {
  const byKey = new Map<string, ReaderState["readRanges"][number]>();

  for (const range of [...local, ...incoming]) {
    const key =
      range.id ??
      [
        range.workId,
        range.startOffset,
        range.endOffset,
        range.start?.textBlockId,
        range.start?.charOffset,
        range.end?.textBlockId,
        range.end?.charOffset,
      ].join(":");
    byKey.set(key, range);
  }

  return Array.from(byKey.values());
}

function mergeBookmarks(local: Bookmark[], incoming: Bookmark[]) {
  const byWork = new Map<string, Bookmark>();

  for (const bookmark of [...local, ...incoming].filter((item) => !item.isCompletionAnchor)) {
    const previous = byWork.get(bookmark.workId);
    if (!previous || timestamp(bookmark.updatedAt) >= timestamp(previous.updatedAt)) {
      byWork.set(bookmark.workId, bookmark);
    }
  }

  return Array.from(byWork.values()).sort(
    (a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt),
  );
}

function newerBookmark(local?: Bookmark, incoming?: Bookmark) {
  if (!local) {
    return incoming;
  }
  if (!incoming) {
    return local;
  }
  return timestamp(incoming.updatedAt) >= timestamp(local.updatedAt) ? incoming : local;
}

function newerPosition(local?: ReadingPosition, incoming?: ReadingPosition) {
  if (!local) {
    return incoming;
  }
  if (!incoming) {
    return local;
  }
  return timestamp(incoming.createdAt) >= timestamp(local.createdAt) ? incoming : local;
}

function timestamp(value?: string) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function normalizeReaderState(state: ReaderState): ReaderState {
  const completedWorkIds = completedWorkIdsFromRanges(state.readRanges);
  const completionAnchor =
    state.completionAnchor ?? state.bookmarks.find((bookmark) => bookmark.isCompletionAnchor);

  return {
    ...state,
    activeSessionStart:
      state.activeSessionStart && completedWorkIds.has(state.activeSessionStart.workId)
        ? undefined
        : state.activeSessionStart,
    completionAnchor: completionAnchor
      ? { ...completionAnchor, isPrimaryForWork: true, isCompletionAnchor: true }
      : undefined,
    bookmarks: normalizeBookmarks(
      state.bookmarks.filter((bookmark) => !bookmark.isCompletionAnchor),
      completedWorkIds,
    ),
  };
}

function normalizeBookmarks(bookmarks: Bookmark[], completedWorkIds: Set<string>) {
  const seenIds = new Set<string>();
  const seenWorks = new Set<string>();
  const normalized: Bookmark[] = [];

  for (const bookmark of bookmarks) {
    if (seenIds.has(bookmark.id)) {
      continue;
    }

    if (seenWorks.has(bookmark.workId) || completedWorkIds.has(bookmark.workId)) {
      continue;
    }

    seenIds.add(bookmark.id);
    seenWorks.add(bookmark.workId);

    normalized.push({ ...bookmark, isPrimaryForWork: true });
  }

  return normalized.slice(0, 80);
}

function upsertPrimaryBookmark(bookmarks: Bookmark[], bookmark: Bookmark) {
  return [
    { ...bookmark, isCompletionAnchor: false },
    ...bookmarks
      .filter((item) => !item.isCompletionAnchor && item.workId !== bookmark.workId)
      .slice(0, 40),
  ];
}

function firstUnreadPosition(work: SutraWork, ranges: ReaderState["readRanges"]) {
  const total = totalChars(work);
  const intervals = ranges
    .filter(
      (range) =>
        typeof range.startOffset === "number" &&
        typeof range.endOffset === "number" &&
        range.endOffset > range.startOffset,
    )
    .map((range) => [range.startOffset ?? 0, range.endOffset ?? 0] as const)
    .sort(([a], [b]) => a - b);
  let cursor = 0;

  for (const [start, end] of intervals) {
    if (start > cursor) {
      break;
    }

    cursor = Math.max(cursor, end);
    if (cursor >= total) {
      break;
    }
  }

  return offsetToPosition(work, Math.min(cursor, total), total > 0 ? cursor / total : 0);
}

function isEndPosition(work: SutraWork, position: ReadingPosition) {
  return positionToOffset(work, position) >= totalChars(work) * completedThreshold;
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
  complete: "#2f7d4f",
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
  complete: "#69c58a",
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
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.18)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  loadingCard: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    maxWidth: "86%",
    minHeight: 54,
    paddingHorizontal: 16,
  },
  loadingOverlayText: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
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
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 22,
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  compactButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  compactButtonText: {
    fontSize: 14,
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
  bookmarkList: {
    maxHeight: 260,
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
  topRightSlot: {
    alignItems: "flex-end",
    minWidth: 68,
  },
  topActionButton: {
    alignItems: "flex-end",
    justifyContent: "center",
    minHeight: 44,
  },
  topActionText: {
    fontSize: 15,
    fontWeight: "700",
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
  libraryProgressRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
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
  miniBarCompact: {
    width: 54,
  },
  miniBarFill: {
    borderRadius: 4,
    height: 8,
  },
  workProgressBadge: {
    alignItems: "center",
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 24,
    paddingHorizontal: 8,
  },
  workProgressText: {
    fontSize: 12,
    fontWeight: "700",
  },
  readerSubhead: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
    textAlign: "center",
  },
  readerProgressRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginBottom: 10,
  },
  readerScroll: {
    flex: 1,
  },
  readerEndPanel: {
    alignItems: "center",
    borderTopWidth: 1,
    marginTop: 14,
    paddingBottom: 28,
    paddingTop: 24,
  },
  readerEndTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  readerEndMeta: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    textAlign: "center",
  },
  readerEndActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
    marginTop: 16,
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
});
