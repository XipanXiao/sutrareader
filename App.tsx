import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Converter } from "opencc-js";
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
import { WebView, WebViewMessageEvent } from "react-native-webview";
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

type Screen = "home" | "category" | "library" | "outline" | "reader";
type Theme = typeof lightTheme;
type ChineseScript = "simplified" | "traditional";
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
  workIndices?: number[];
  label: string;
  categoryId: string;
  categoryLabel: string;
};
type GlobalProgressCategoryGroup = {
  id: string;
  categoryId: string;
  label: string;
  segments: GlobalProgressSegment[];
};

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const toTraditional = Converter({ from: "cn", to: "tw" });
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
  const [readerReturnScreen, setReaderReturnScreen] = useState<Screen>("home");
  const [chineseScript, setChineseScript] = useState<ChineseScript>("simplified");
  const [selectedCategory, setSelectedCategory] =
    useState<GlobalProgressCategoryGroup>();
  const [selectedCategorySegmentId, setSelectedCategorySegmentId] = useState<string>();

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

  const openReaderAt = async (position: ReadingPosition, returnScreen: Screen = screen) => {
    setLoadingMessage(`正在打开《${workTitle(currentWork, chineseScript)}》`);
    await waitForLoadingPaint();
    setCurrentPosition(position);
    persist({ ...readerState, lastPosition: position });
    setReaderOpenKey((value) => value + 1);
    setReaderReturnScreen(returnScreen === "reader" ? "home" : returnScreen);
    setScreen("reader");
    setTimeout(() => setLoadingMessage(undefined), 120);
  };

  const openCatalogItem = async (
    item: CbetaCatalogItem,
    destination: Screen = "home",
    stateOverride?: ReaderState,
    positionOverride?: ReadingPosition,
    returnScreenOverride?: Screen,
  ) => {
    const baseState = stateOverride ?? readerState;
    setLoadingMessage(`正在载入《${catalogTitle(item, chineseScript)}》`);
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
        setReaderReturnScreen(
          returnScreenOverride ?? (screen === "reader" ? readerReturnScreen : screen),
        );
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
      openReaderAt(positionForBookmarkInWork(bookmark, currentWork), screen);
      return;
    }

    const item = catalogItemForBookmark(bookmark);
    if (!item) {
      setLoadingMessage("无法在经藏中找到这个书签对应的经文");
      return;
    }

    setLoadingMessage(`正在载入《${catalogTitle(item, chineseScript)}》`);
    try {
      await waitForLoadingPaint();
      const work = await loadCbetaWork(item);
      const position = positionForBookmarkInWork(bookmark, work);
      setCurrentWork(work);
      setCurrentPosition(position);
      persist({ ...readerState, lastPosition: position });
      setReaderOpenKey((value) => value + 1);
      setReaderReturnScreen(screen === "reader" ? readerReturnScreen : screen);
      setScreen("reader");
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "无法载入这个书签对应的经文",
      );
      return;
    }
    setTimeout(() => setLoadingMessage(undefined), 120);
  };

  const openPosition = async (position: ReadingPosition) => {
    if (
      position.workId === currentWork.id ||
      currentWork.blocks.some((block) => block.id === position.textBlockId)
    ) {
      openReaderAt(positionForSavedPositionInWork(position, currentWork), "home");
      return;
    }

    const item = catalogItemForPosition(position);
    if (!item) {
      openReaderAt(currentPosition, "home");
      return;
    }

    setLoadingMessage(`正在载入《${catalogTitle(item, chineseScript)}》`);
    try {
      await waitForLoadingPaint();
      const work = await loadCbetaWork(item);
      const nextPosition = positionForSavedPositionInWork(position, work);
      setCurrentWork(work);
      setCurrentPosition(nextPosition);
      persist({ ...readerState, lastPosition: nextPosition });
      setReaderOpenKey((value) => value + 1);
      setReaderReturnScreen("home");
      setScreen("reader");
    } catch (error) {
      setLoadingMessage(
        error instanceof Error ? error.message : "无法载入上次阅读的经文",
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

  const toggleChineseScript = () => {
    setChineseScript((value) =>
      value === "simplified" ? "traditional" : "simplified",
    );
    setReaderOpenKey((value) => value + 1);
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
          chineseScript={chineseScript}
          currentWorkProgress={progress}
          onOpenLibrary={() => setScreen("library")}
          onOpenOutline={() => setScreen("outline")}
          onContinue={() =>
            readerState.lastPosition
              ? openPosition(readerState.lastPosition)
              : latestBookmark
                ? openBookmark(latestBookmark)
                : openReaderAt(currentPosition, "home")
          }
          onOpenCategory={(category) => {
            setSelectedCategory(category);
            setSelectedCategorySegmentId(undefined);
            setScreen("category");
          }}
          onOpenBookmark={openBookmark}
          onDeleteBookmark={deleteBookmark}
          onExportProgress={exportProgress}
          onImportProgress={importProgress}
          onToggleChineseScript={toggleChineseScript}
          onLoadDefault={() => openCatalogItem(defaultCatalogItem)}
        />
      ) : null}
      {screen === "category" && selectedCategory ? (
        <CategoryProgressScreen
          theme={theme}
          category={selectedCategory}
          selectedSegmentId={selectedCategorySegmentId}
          globalProgress={globalProgress}
          readerState={readerState}
          onBack={() => setScreen("home")}
          onSelectSegment={setSelectedCategorySegmentId}
          onOpenSegment={(segment) =>
            readerState.completionAnchor &&
            isWorkInGlobalSegment(readerState.completionAnchor.workId, segment)
              ? openBookmark(readerState.completionAnchor)
              : openGlobalSegment(
                  segment,
                  globalProgress.workFractions,
                  readerState.readRanges,
                  openCatalogItem,
                  setLoadingMessage,
                  "category",
                )
          }
          onOpenWork={(item) => {
            openCatalogItem(item, "reader", undefined, undefined, "category");
          }}
        />
      ) : null}
      {screen === "library" ? (
        <LibraryScreen
          theme={theme}
          globalProgress={globalProgress}
          chineseScript={chineseScript}
          onBack={() => setScreen("home")}
          onOpen={openCatalogItem}
        />
      ) : null}
      {screen === "outline" ? (
        <OutlineScreen
          theme={theme}
          work={currentWork}
          chineseScript={chineseScript}
          readerState={readerState}
          onBack={() => setScreen("home")}
          onOpen={openReaderAt}
        />
      ) : null}
      {screen === "reader" ? (
        <ReaderScreen
          theme={theme}
          work={currentWork}
          chineseScript={chineseScript}
          position={currentPosition}
          progress={progress}
          restoreKey={readerOpenKey}
          onBack={() => setScreen(readerReturnScreen)}
          onPositionChange={(position) => {
            setCurrentPosition(position);
            setReaderState((state) => {
              const nextState = { ...state, lastPosition: position };
              saveReaderState(nextState);
              return nextState;
            });
          }}
          onMarkHere={markHere}
          nextWorkTitle={
            nextCatalogItem ? catalogTitle(nextCatalogItem, chineseScript) : undefined
          }
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
  chineseScript,
  currentWorkProgress,
  onOpenLibrary,
  onOpenOutline,
  onContinue,
  onOpenCategory,
  onOpenBookmark,
  onDeleteBookmark,
  onExportProgress,
  onImportProgress,
  onToggleChineseScript,
  onLoadDefault,
}: {
  theme: Theme;
  currentWork: SutraWork;
  globalSegments: GlobalProgressSegment[];
  readerState: ReaderState;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
  chineseScript: ChineseScript;
  currentWorkProgress: number;
  onOpenLibrary: () => void;
  onOpenOutline: () => void;
  onContinue: () => void;
  onOpenCategory: (category: GlobalProgressCategoryGroup) => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onExportProgress: () => void;
  onImportProgress: () => void;
  onToggleChineseScript: () => void;
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
  const progressGroups = groupGlobalProgressSegments(globalSegments);
  const currentCatalogIndex = catalogIndexForWork(currentWork);
  const currentCategoryId =
    currentCatalogIndex === undefined
      ? undefined
      : categoryForCatalogItem(cbetaCatalog[currentCatalogIndex]).id;

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
        {cbetaCatalog.length.toLocaleString()} 部。当前：{workTitle(currentWork, chineseScript)}（
        {Math.round(currentWorkProgress * 100)}%）。
      </Text>

      <View style={styles.mapGroups}>
        {progressGroups.map((group) => (
          <CategoryProgressCard
            key={group.id}
            theme={theme}
            category={group}
            fraction={categoryProgressFraction(group, globalProgress.workFractions)}
            current={group.categoryId === currentCategoryId}
            onPress={() => onOpenCategory(group)}
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
        <CompactButton
          label={
            chineseScript === "simplified" ? "当前显示简体，轻点切换繁体" : "当前顯示繁體，輕點切換簡體"
          }
          text={chineseScript === "simplified" ? "简" : "繁"}
          theme={theme}
          filled
          onPress={onToggleChineseScript}
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
              chineseScript={chineseScript}
              progress={globalProgress.workFractions[bookmark.workId] ?? 0}
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

function CategoryProgressCard({
  theme,
  category,
  fraction,
  current,
  onPress,
}: {
  theme: Theme;
  category: GlobalProgressCategoryGroup;
  fraction: number;
  current: boolean;
  onPress: () => void;
}) {
  const complete = fraction >= completedThreshold;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${category.label}，已读 ${Math.round(fraction * 100)}%`}
      onPress={onPress}
      style={[
        styles.categoryCard,
        {
          backgroundColor: theme.input,
          borderColor: current ? theme.accent : theme.border,
        },
        current ? styles.categoryCardCurrent : null,
      ]}
    >
      <View
        style={[
          styles.categoryCardFill,
          {
            backgroundColor: complete ? theme.complete : theme.partial,
            width: `${Math.round(fraction * 100)}%`,
          },
        ]}
      />
      <Text style={[styles.categoryCardTitle, { color: theme.text }]} numberOfLines={2}>
        {category.label}
      </Text>
      <Text style={[styles.categoryCardMeta, { color: theme.muted }]}>
        {formatPercent(fraction)}
      </Text>
    </Pressable>
  );
}

function CategoryProgressScreen({
  theme,
  category,
  selectedSegmentId,
  globalProgress,
  readerState,
  onBack,
  onSelectSegment,
  onOpenSegment,
  onOpenWork,
}: {
  theme: Theme;
  category: GlobalProgressCategoryGroup;
  selectedSegmentId?: string;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
  readerState: ReaderState;
  onBack: () => void;
  onSelectSegment: (segmentId: string) => void;
  onOpenSegment: (segment: GlobalProgressSegment) => void;
  onOpenWork: (item: CbetaCatalogItem) => void;
}) {
  const segments = useMemo(() => createCategoryDetailSegments(category), [category]);
  const firstUnread =
    segments.find((segment) => globalSegmentFraction(segment, globalProgress.workFractions) < completedThreshold) ??
    segments[0];
  useEffect(() => {
    if (!selectedSegmentId && firstUnread) {
      onSelectSegment(firstUnread.id);
    }
  }, [firstUnread, onSelectSegment, selectedSegmentId]);
  const selectedSegment =
    segments.find((segment) => segment.id === selectedSegmentId) ?? firstUnread;
  const selectedItems = selectedSegment ? catalogItemsForSegment(selectedSegment) : [];
  const fraction = categoryProgressFraction(category, globalProgress.workFractions);
  const categoryIndices = categoryWorkIndices(category.categoryId);
  const inProgressCount = categoryIndices.filter((index) => {
    const progress = globalProgress.workFractions[cbetaCatalog[index]?.id ?? ""] ?? 0;
    return progress > 0 && progress < completedThreshold;
  }).length;
  const visibleBookmarks = readerState.bookmarks.filter(
    (bookmark) =>
      !bookmark.isCompletionAnchor &&
      (globalProgress.workFractions[bookmark.workId] ?? 0) < completedThreshold,
  );

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title={category.label} onBack={onBack} />
      <Text style={[styles.categoryDetailMeta, { color: theme.muted }]}>
        已读 {formatPercent(fraction)} · {categoryIndices.length} 部 ·{" "}
        {inProgressCount} 部进行中
      </Text>
      <View style={[styles.categoryDetailBar, { backgroundColor: theme.dot }]}>
        <View
          style={[
            styles.categoryDetailBarFill,
            {
              backgroundColor: fraction >= completedThreshold ? theme.complete : theme.accent,
              width: `${Math.round(fraction * 100)}%`,
            },
          ]}
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.categoryDotMap}
        showsVerticalScrollIndicator={false}
      >
        {segments.map((segment) => (
          <ProgressDot
            key={segment.id}
            theme={theme}
            fraction={globalSegmentFraction(segment, globalProgress.workFractions)}
            bookmarked={visibleBookmarks.some((bookmark) =>
              isWorkInGlobalSegment(bookmark.workId, segment),
            )}
            selected={segment.id === selectedSegment?.id}
            label={segment.label}
            onPress={() => onSelectSegment(segment.id)}
          />
        ))}
        <View style={styles.categoryActions}>
          {firstUnread ? (
            <Button label="继续本类" theme={theme} filled onPress={() => onOpenSegment(firstUnread)} />
          ) : null}
        </View>
        <View style={styles.segmentWorkPanel}>
          <Text style={[styles.segmentWorkTitle, { color: theme.text }]}>
            {selectedSegment
              ? `${selectedSegment.label} · ${selectedItems.length} 部`
              : "暂无经文"}
          </Text>
          {selectedItems.map((item) => (
            <CategoryWorkRow
              key={item.id}
              item={item}
              progress={globalProgress.workFractions[item.id] ?? 0}
              theme={theme}
              onOpen={() => onOpenWork(item)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CategoryWorkRow({
  item,
  progress,
  theme,
  onOpen,
}: {
  item: CbetaCatalogItem;
  progress: number;
  theme: Theme;
  onOpen: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开 ${item.titleSimplified ?? item.title}`}
      onPress={onOpen}
      style={[styles.segmentWorkRow, { borderColor: theme.border }]}
    >
      <View style={styles.segmentWorkCopy}>
        <Text style={[styles.segmentWorkName, { color: theme.text }]} numberOfLines={1}>
          {item.titleSimplified ?? item.title}
        </Text>
        <Text style={[styles.segmentWorkMeta, { color: theme.muted }]} numberOfLines={1}>
          {item.sourceId} · {item.volume}
        </Text>
      </View>
      <WorkProgressBadge theme={theme} progress={progress} />
    </Pressable>
  );
}

function BookmarkRow({
  bookmark,
  theme,
  chineseScript,
  progress,
  onOpen,
  onDelete,
}: {
  bookmark: Bookmark;
  theme: Theme;
  chineseScript: ChineseScript;
  progress: number;
  onOpen: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}) {
  const deleteWidth = 96;
  const translateX = useRef(new Animated.Value(0)).current;
  const startOffset = useRef(0);
  const currentOffset = useRef(0);
  const revealed = useRef(false);
  const bookmarkTitle = displayText(bookmark.title, chineseScript);

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
        accessibilityLabel={`删除书签 ${bookmarkTitle}`}
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
          accessibilityLabel={`打开书签 ${bookmarkTitle}`}
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
          <View style={styles.bookmarkDetails}>
            <Text style={[styles.bookmark, { color: theme.muted }]} numberOfLines={2}>
              {bookmarkTitle}
            </Text>
            <MiniBar theme={theme} fraction={progress} compact />
          </View>
          <View style={styles.bookmarkMeta}>
            <WorkProgressBadge theme={theme} progress={progress} />
            <Text style={[styles.bookmarkAction, { color: theme.accent }]}>打开</Text>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function LibraryScreen({
  theme,
  globalProgress,
  chineseScript,
  onBack,
  onOpen,
}: {
  theme: Theme;
  globalProgress: ReturnType<typeof calculateGlobalProgress>;
  chineseScript: ChineseScript;
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
            chineseScript={chineseScript}
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
  chineseScript,
  onOpen,
}: {
  item: CbetaCatalogItem;
  cached: boolean;
  progress: number;
  theme: Theme;
  chineseScript: ChineseScript;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onPress={onOpen}
      style={[styles.libraryRow, { borderColor: theme.border }]}
    >
      <View style={styles.libraryText}>
        <Text style={[styles.outlineTitle, { color: theme.text }]} numberOfLines={1}>
          {catalogTitle(item, chineseScript)}
        </Text>
        <Text style={[styles.outlineMeta, { color: theme.muted }]} numberOfLines={1}>
          {catalogCanonTitle(item, chineseScript)} - {item.volume} - {item.sourceId}
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
  chineseScript,
  readerState,
  onBack,
  onOpen,
}: {
  theme: Theme;
  work: SutraWork;
  chineseScript: ChineseScript;
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
                  {displayText(section.title, chineseScript)}
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
  chineseScript,
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
  chineseScript: ChineseScript;
  position: ReadingPosition;
  progress: number;
  restoreKey: number;
  onBack: () => void;
  onPositionChange: (position: ReadingPosition) => void;
  onMarkHere: () => void;
  nextWorkTitle?: string;
  onOpenNextWork: () => void;
}) {
  const readerItems = useMemo(
    () => createReaderTextItems(work, chineseScript),
    [chineseScript, work],
  );
  const targetItem = readerItemForPosition(readerItems, position) ?? readerItems[0];
  const activeItemId = targetItem?.id;
  const workRef = useRef(work);
  const onPositionChangeRef = useRef(onPositionChange);
  const readerItemsRef = useRef(readerItems);
  const lastReportedItemRef = useRef("");
  const webViewRef = useRef<WebView>(null);
  const [readerSource, setReaderSource] = useState<{ uri: string; key: string }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState("");

  useEffect(() => {
    workRef.current = work;
    onPositionChangeRef.current = onPositionChange;
    readerItemsRef.current = readerItems;
  }, [onPositionChange, readerItems, work]);

  useEffect(() => {
    let cancelled = false;
    setReaderSource(undefined);
    const targetAnchorId = targetItem
      ? readerAnchorId(targetItem, position.charOffset)
      : undefined;
    const sourceKey = `${work.id}-${chineseScript}-${restoreKey}-${targetAnchorId ?? "top"}`;
    const html = createReaderHtml({
      theme,
      work,
      readerItems,
      activeItemId,
      nextWorkTitle,
    });

    lastReportedItemRef.current = "";

    writeReaderHtml(work.id, sourceKey, html, targetAnchorId)
      .then((uri) => {
        if (!cancelled) {
          setReaderSource({ uri, key: sourceKey });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReaderSource({
            uri: readerDataUri(html, targetAnchorId),
            key: sourceKey,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chineseScript, nextWorkTitle, readerItems, restoreKey, theme, work]);

  const positionFromReaderItem = (
    item: ReaderTextItem,
    charOffset: number,
    scrollFraction: number,
  ) => {
    const currentWork = workRef.current;
    const chars = totalChars(currentWork);
    const absoluteOffset = positionToOffset(
      currentWork,
      makePosition(currentWork.id, item.block, charOffset, scrollFraction),
    );

    return makePosition(
      currentWork.id,
      item.block,
      charOffset,
      chars > 0 ? absoluteOffset / chars : scrollFraction,
    );
  };

  const handleReaderMessage = (event: WebViewMessageEvent) => {
    let message:
      | {
          type: "position" | "select" | "next" | "searchResult";
          itemId?: string;
          charOffset?: number;
          scrollFraction?: number;
          found?: boolean;
        }
      | undefined;

    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (!message) {
      return;
    }

    if (message.type === "next") {
      onOpenNextWork();
      return;
    }

    if (message.type === "searchResult") {
      setSearchStatus(message.found ? "已定位" : "未找到");
      return;
    }

    const item = readerItemsRef.current.find((candidate) => candidate.id === message.itemId);
    if (!item) {
      return;
    }

    if (message.type === "position" && item.id === lastReportedItemRef.current) {
      return;
    }

    if (message.type === "position") {
      lastReportedItemRef.current = item.id;
    }

    const charOffset = Math.max(
      item.charStart,
      Math.min(message.charOffset ?? item.charStart, item.charEnd),
    );
    onPositionChangeRef.current(
      positionFromReaderItem(item, charOffset, message.scrollFraction ?? 0),
    );
  };

  const runReaderSearch = () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchStatus("");
      return;
    }

    setSearchStatus("查找中");
    webViewRef.current?.injectJavaScript(
      `window.__sutraSearch && window.__sutraSearch(${JSON.stringify(query)}); true;`,
    );
  };

  const readerRightAction = (
    <View style={styles.readerTopActions}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查找经文"
        onPress={() => {
          setSearchOpen((value) => !value);
          setSearchStatus("");
        }}
        style={styles.iconButton}
      >
        <SearchGlyph color={theme.accent} />
      </Pressable>
      <Pressable onPress={onMarkHere} style={styles.topActionButton}>
        <Text style={[styles.topActionText, { color: theme.accent }]}>记到此处</Text>
      </Pressable>
    </View>
  );

  if (!readerSource) {
    return (
      <View style={styles.screen}>
        <TopBar
          theme={theme}
          title={workTitle(work, chineseScript)}
          onBack={onBack}
          rightAction={readerRightAction}
        />
        {searchOpen ? (
          <ReaderSearchBar
            theme={theme}
            query={searchQuery}
            status={searchStatus}
            onChangeQuery={setSearchQuery}
            onSubmit={runReaderSearch}
          />
        ) : null}
        <Text style={[styles.readerSubhead, { color: theme.muted }]} numberOfLines={2}>
          {displayText(work.subtitle, chineseScript)}
        </Text>
        <View style={styles.readerProgressRow}>
          <WorkProgressBadge theme={theme} progress={progress} />
          <MiniBar theme={theme} fraction={progress} />
        </View>
        <View style={styles.readerLoading}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.readerLoadingText, { color: theme.muted }]}>正在排版经文</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <TopBar
        theme={theme}
        title={workTitle(work, chineseScript)}
        onBack={onBack}
        rightAction={readerRightAction}
      />
      {searchOpen ? (
        <ReaderSearchBar
          theme={theme}
          query={searchQuery}
          status={searchStatus}
          onChangeQuery={setSearchQuery}
          onSubmit={runReaderSearch}
        />
      ) : null}
      <Text style={[styles.readerSubhead, { color: theme.muted }]} numberOfLines={2}>
        {displayText(work.subtitle, chineseScript)}
      </Text>
      <View style={styles.readerProgressRow}>
        <WorkProgressBadge theme={theme} progress={progress} />
        <MiniBar theme={theme} fraction={progress} />
      </View>

      <WebView
        ref={webViewRef}
        key={readerSource.key}
        originWhitelist={["*"]}
        source={{ uri: readerSource.uri }}
        onMessage={handleReaderMessage}
        javaScriptEnabled
        domStorageEnabled={false}
        showsVerticalScrollIndicator={false}
        style={[styles.readerWebView, { backgroundColor: theme.background }]}
      />
    </View>
  );
}

function ProgressDot({
  theme,
  fraction,
  bookmarked,
  selected = false,
  label,
  onPress,
}: {
  theme: Theme;
  fraction: number;
  bookmarked: boolean;
  selected?: boolean;
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
        selected
          ? { borderColor: theme.text, borderWidth: 2 }
          : bookmarked
            ? { borderColor: theme.accent, borderWidth: 1 }
            : null,
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

function createReaderTextItems(work: SutraWork, chineseScript: ChineseScript): ReaderTextItem[] {
  return work.blocks.map((block) => {
    const text = chineseScript === "traditional" ? block.textSource : block.textSimplified;

    return {
      id: block.id,
      block,
      text,
      charStart: 0,
      charEnd: text.length,
      title: block.title ? displayText(block.title, chineseScript) : undefined,
    };
  });
}

function readerItemForPosition(
  readerItems: ReaderTextItem[],
  position: ReadingPosition,
) {
  return readerItems.find(
    (item) =>
      item.block.id === position.textBlockId &&
      position.charOffset >= item.charStart &&
      position.charOffset <= item.charEnd,
  );
}

const readerAnchorStep = 24;

function readerAnchorOffset(item: ReaderTextItem, charOffset: number) {
  const length = item.charEnd - item.charStart;
  if (length <= 0) {
    return 0;
  }

  const relative = Math.max(0, Math.min(charOffset - item.charStart, length - 1));
  return Math.floor(relative / readerAnchorStep) * readerAnchorStep;
}

function readerAnchorId(item: ReaderTextItem, charOffset: number) {
  return `${item.id}-c${readerAnchorOffset(item, charOffset)}`;
}

function createReaderHtml({
  theme,
  work,
  readerItems,
  activeItemId,
  nextWorkTitle,
}: {
  theme: Theme;
  work: SutraWork;
  readerItems: ReaderTextItem[];
  activeItemId?: string;
  nextWorkTitle?: string;
}) {
  const blocksHtml = readerItems
    .map((item) => {
      const title = item.title
        ? `<div class="block-title">${escapeHtml(item.title)}</div>`
        : "";
      const selected = item.id === activeItemId ? " selected" : "";
      return `<section class="reader-block${selected}" id="${escapeAttribute(
        item.id,
      )}" data-item-id="${escapeAttribute(item.id)}" data-block-id="${escapeAttribute(
        item.block.id,
      )}" data-char-start="${item.charStart}" data-char-end="${item.charEnd}">${title}<p>${readerTextWithAnchors(
        item,
      )}</p></section>`;
    })
    .join("");
  const endPanel = `<section class="end-panel"><h2>已到本部末尾</h2><p>${
    nextWorkTitle ? `下一部：${escapeHtml(nextWorkTitle)}` : "已到经藏末尾"
  }</p>${nextWorkTitle ? `<button id="next-work">下一部</button>` : ""}</section>`;

  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<style>
  :root {
    color-scheme: light dark;
    background: ${theme.background};
  }
  html {
    background: ${theme.background};
    scroll-behavior: auto;
  }
  body {
    margin: 0;
    padding: 8px 26px 34px;
    background: ${theme.background};
    color: ${theme.text};
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .reader-block {
    margin: 0 0 20px;
    padding: 12px 0;
    border-radius: 8px;
  }
  .reader-block.selected {
    background: ${theme.selection};
  }
  .block-title {
    margin: 0 0 8px;
    color: ${theme.accent};
    font-size: 20px;
    font-weight: 700;
    line-height: 1.45;
  }
  p {
    margin: 0;
    color: ${theme.text};
    font-size: 24px;
    font-weight: 400;
    line-height: 1.75;
    letter-spacing: 0;
    word-break: break-word;
  }
  .reader-anchor {
    scroll-margin-top: 14px;
  }
  .search-hit {
    background: ${theme.selection};
    border-radius: 4px;
  }
  .end-panel {
    margin: 20px 0 0;
    padding: 20px 0 30px;
    border-top: 1px solid ${theme.border};
  }
  .end-panel h2 {
    margin: 0 0 8px;
    color: ${theme.text};
    font-size: 20px;
    line-height: 1.4;
  }
  .end-panel p {
    margin: 0 0 14px;
    color: ${theme.muted};
    font-size: 16px;
    line-height: 1.5;
  }
  button {
    appearance: none;
    border: 1px solid ${theme.accent};
    border-radius: 8px;
    background: ${theme.accent};
    color: ${theme.onAccent};
    padding: 13px 22px;
    font-size: 18px;
    font-weight: 700;
  }
</style>
</head>
<body>
${blocksHtml}
${endPanel}
<script>
(() => {
  const post = (payload) => {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  const scrollFraction = () => {
    const root = document.documentElement;
    const max = Math.max(1, root.scrollHeight - window.innerHeight);
    return Math.max(0, Math.min(window.scrollY / max, 1));
  };
  const selectBlock = (block) => {
    document.querySelectorAll(".reader-block.selected").forEach((node) => {
      node.classList.remove("selected");
    });
    block.classList.add("selected");
  };
  const messageForBlock = (block, type) => {
    const rect = block.getBoundingClientRect();
    const start = Number(block.dataset.charStart || 0);
    const end = Number(block.dataset.charEnd || start);
    const ratio = Math.max(0, Math.min((28 - rect.top) / Math.max(1, rect.height), 1));
    return {
      type,
      itemId: block.dataset.itemId,
      charOffset: Math.floor(start + (end - start) * ratio),
      scrollFraction: scrollFraction()
    };
  };
  const clearSearchHit = () => {
    document.querySelectorAll(".search-hit").forEach((node) => {
      node.classList.remove("search-hit");
    });
  };
  window.__sutraSearch = (query) => {
    const term = String(query || "").trim();
    clearSearchHit();

    if (!term) {
      post({ type: "searchResult", found: false });
      return;
    }

    const blocks = Array.from(document.querySelectorAll(".reader-block"));
    for (const block of blocks) {
      const text = block.querySelector("p")?.textContent || "";
      const index = text.indexOf(term);
      if (index < 0) {
        continue;
      }

      const anchorOffset = Math.floor(index / ${readerAnchorStep}) * ${readerAnchorStep};
      const anchorId = block.dataset.itemId + "-c" + anchorOffset;
      const anchor = document.getElementById(anchorId) || block;
      selectBlock(block);
      anchor.classList.add("search-hit");
      anchor.scrollIntoView({ block: "start", inline: "nearest" });
      window.setTimeout(() => {
        post({
          type: "select",
          itemId: block.dataset.itemId,
          charOffset: Number(block.dataset.charStart || 0) + index,
          scrollFraction: scrollFraction()
        });
        post({ type: "searchResult", found: true });
      }, 80);
      return;
    }

    post({ type: "searchResult", found: false });
  };
  document.addEventListener("click", (event) => {
    const nextButton = event.target.closest("#next-work");
    if (nextButton) {
      post({ type: "next" });
      return;
    }

    const block = event.target.closest(".reader-block");
    if (!block) {
      return;
    }

    selectBlock(block);
    post(messageForBlock(block, "select"));
  });

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      const block = Array.from(document.querySelectorAll(".reader-block")).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom >= 28;
      });
      if (block) {
        post(messageForBlock(block, "position"));
      }
    });
  }, { passive: true });
})();
</script>
</body>
</html>`;
}

function readerTextWithAnchors(item: ReaderTextItem) {
  const parts: string[] = [];
  const length = item.charEnd - item.charStart;
  let offset = 0;

  while (offset < length) {
    const nextOffset = Math.min(length, offset + readerAnchorStep);
    const anchorId = `${item.id}-c${offset}`;
    parts.push(
      `<span id="${escapeAttribute(anchorId)}" class="reader-anchor">${escapeHtml(
        item.text.slice(offset, nextOffset),
      )}</span>`,
    );
    offset = nextOffset;
  }

  if (parts.length === 0) {
    parts.push(
      `<span id="${escapeAttribute(`${item.id}-c0`)}" class="reader-anchor"></span>`,
    );
  }

  return parts.join("");
}

async function writeReaderHtml(
  workId: string,
  sourceKey: string,
  html: string,
  targetAnchorId?: string,
) {
  const root = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!root) {
    return readerDataUri(html, targetAnchorId);
  }

  const directory = `${root}reader-html`;
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }

  const fileUri = `${directory}/${safeFileName(`${workId}-${sourceKey}`)}.html`;
  await FileSystem.writeAsStringAsync(fileUri, html);
  return `${fileUri}${targetAnchorId ? `#${encodeURIComponent(targetAnchorId)}` : ""}`;
}

function readerDataUri(html: string, targetAnchorId?: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}${
    targetAnchorId ? `#${encodeURIComponent(targetAnchorId)}` : ""
  }`;
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
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
  filled,
  onPress,
}: {
  label: string;
  text: string;
  theme: Theme;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.compactButton,
        {
          backgroundColor: filled ? theme.accent : "transparent",
          borderColor: filled ? theme.accent : theme.border,
        },
      ]}
    >
      <Text
        style={[
          styles.compactButtonText,
          { color: filled ? theme.onAccent : theme.text },
        ]}
      >
        {text}
      </Text>
    </Pressable>
  );
}

function ReaderSearchBar({
  theme,
  query,
  status,
  onChangeQuery,
  onSubmit,
}: {
  theme: Theme;
  query: string;
  status: string;
  onChangeQuery: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.readerSearchRow}>
      <TextInput
        value={query}
        onChangeText={onChangeQuery}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="查找经文"
        placeholderTextColor={theme.muted}
        style={[
          styles.readerSearchInput,
          { borderColor: theme.border, color: theme.text },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查找"
        onPress={onSubmit}
        style={[styles.readerSearchButton, { backgroundColor: theme.accent }]}
      >
        <Text style={[styles.readerSearchButtonText, { color: theme.onAccent }]}>查找</Text>
      </Pressable>
      {status ? (
        <Text style={[styles.readerSearchStatus, { color: theme.muted }]}>{status}</Text>
      ) : null}
    </View>
  );
}

function SearchGlyph({ color }: { color: string }) {
  return (
    <View style={styles.searchGlyphBox}>
      <View style={[styles.searchGlyphCircle, { borderColor: color }]} />
      <View style={[styles.searchGlyphHandle, { backgroundColor: color }]} />
    </View>
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
    const categoryItem =
      cbetaCatalog[Math.floor((startIndex + Math.max(startIndex, endIndex - 1)) / 2)] ??
      first;
    const category = categoryForCatalogItem(categoryItem);

    return {
      id: `global-${index}`,
      order: index,
      startIndex,
      endIndex: Math.max(startIndex + 1, endIndex),
      label: `${first?.canonTitle ?? "CBETA"} ${first?.sourceId ?? ""} - ${
        last?.sourceId ?? ""
      }`,
      categoryId: category.id,
      categoryLabel: category.label,
    };
  });
}

function groupGlobalProgressSegments(
  segments: GlobalProgressSegment[],
): GlobalProgressCategoryGroup[] {
  const groupsByCategory = new Map<string, GlobalProgressCategoryGroup>();

  for (const segment of segments) {
    const current = groupsByCategory.get(segment.categoryId);
    if (current) {
      current.segments.push(segment);
    } else {
      groupsByCategory.set(segment.categoryId, {
        id: segment.categoryId,
        categoryId: segment.categoryId,
        label: segment.categoryLabel,
        segments: [segment],
      });
    }
  }

  return [...groupsByCategory.values()].sort(
    (left, right) =>
      categoryDisplayOrder(left.categoryId) - categoryDisplayOrder(right.categoryId),
  );
}

const categoryOrder = [
  "T-阿含部",
  "T-本缘部",
  "T-般若部",
  "T-法华部",
  "T-华严部",
  "T-宝积涅槃大集部",
  "T-经集部",
  "T-密教部",
  "other",
];

function categoryDisplayOrder(categoryId: string) {
  const index = categoryOrder.indexOf(categoryId);
  return index >= 0 ? index : categoryOrder.length;
}

function categoryWorkIndices(categoryId: string) {
  return cbetaCatalog
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => categoryForCatalogItem(item).id === categoryId)
    .map(({ index }) => index);
}

function categoryProgressFraction(
  category: GlobalProgressCategoryGroup,
  workFractions: Record<string, number>,
) {
  const indices = categoryWorkIndices(category.categoryId);
  if (indices.length === 0) {
    return 0;
  }

  const total = indices.reduce(
    (sum, index) => sum + (workFractions[cbetaCatalog[index]?.id ?? ""] ?? 0),
    0,
  );
  return total / indices.length;
}

function createCategoryDetailSegments(category: GlobalProgressCategoryGroup) {
  const workIndices = categoryWorkIndices(category.categoryId);
  const segmentCount = Math.min(workIndices.length, 96);
  if (segmentCount === 0) {
    return [];
  }

  return Array.from({ length: segmentCount }, (_, index) => {
    const start = Math.floor((workIndices.length * index) / segmentCount);
    const end = Math.max(start + 1, Math.floor((workIndices.length * (index + 1)) / segmentCount));
    const segmentIndices = workIndices.slice(start, end);
    const first = cbetaCatalog[segmentIndices[0]];
    const last = cbetaCatalog[segmentIndices[segmentIndices.length - 1]];

    return {
      id: `${category.id}-detail-${index}`,
      order: index,
      startIndex: segmentIndices[0],
      endIndex: (segmentIndices[segmentIndices.length - 1] ?? segmentIndices[0]) + 1,
      workIndices: segmentIndices,
      label: `${category.label} ${first?.sourceId ?? ""} - ${last?.sourceId ?? ""}`,
      categoryId: category.categoryId,
      categoryLabel: category.label,
    };
  });
}

const taishoCategoryRanges = [
  [1, 151, "阿含部"],
  [152, 219, "本缘部"],
  [220, 261, "般若部"],
  [262, 277, "法华部"],
  [278, 309, "华严部"],
  [310, 424, "宝积涅槃大集部"],
  [425, 847, "经集部"],
  [848, 1420, "密教部"],
] as const;

function categoryForCatalogItem(item?: CbetaCatalogItem) {
  if (!item) {
    return { id: "unknown", label: "CBETA" };
  }

  if (item.canon === "T") {
    const number = Number.parseInt(item.number, 10);
    const range = taishoCategoryRanges.find(
      ([start, end]) => number >= start && number <= end,
    );
    if (range) {
      return { id: `T-${range[2]}`, label: range[2] };
    }
  }

  return { id: "other", label: "其他" };
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
  const items = catalogItemsForSegment(segment);
  if (items.length === 0) {
    return 0;
  }

  const total = items.reduce((sum, item) => sum + (workFractions[item.id] ?? 0), 0);
  return total / items.length;
}

function isWorkInGlobalSegment(workId: string, segment: GlobalProgressSegment) {
  const index = catalogIndexById.get(workId);
  return (
    index !== undefined &&
    (segment.workIndices
      ? segment.workIndices.includes(index)
      : index >= segment.startIndex && index < segment.endIndex)
  );
}

function catalogItemsForSegment(segment: GlobalProgressSegment) {
  if (segment.workIndices) {
    return segment.workIndices
      .map((index) => cbetaCatalog[index])
      .filter((item): item is CbetaCatalogItem => Boolean(item));
  }

  return cbetaCatalog.slice(segment.startIndex, segment.endIndex);
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

function catalogItemForPosition(position: ReadingPosition) {
  return (
    cbetaCatalog.find((item) => item.id === position.workId) ??
    cbetaCatalog.find((item) =>
      normalizeSearchText(position.anchorId).includes(normalizeSearchText(item.sourceId)),
    )
  );
}

function positionForBookmarkInWork(bookmark: Bookmark, work: SutraWork): ReadingPosition {
  return positionForSavedPositionInWork(bookmark.position, work);
}

function positionForSavedPositionInWork(
  position: ReadingPosition,
  work: SutraWork,
): ReadingPosition {
  const block = work.blocks.find((item) => item.id === position.textBlockId);
  if (!block) {
    return offsetToPosition(work, 0);
  }

  return {
    ...position,
    workId: work.id,
    textBlockId: block.id,
    anchorId: block.anchorId,
    charOffset: Math.max(
      0,
      Math.min(position.charOffset, block.textSimplified.length),
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
    returnScreenOverride?: Screen,
  ) => void,
  setLoadingMessage?: (message: string | undefined) => void,
  returnScreenOverride?: Screen,
) {
  const items = catalogItemsForSegment(segment);
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
        returnScreenOverride,
      );
    });
  }
}

function waitForLoadingPaint() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

function displayText(value: string | undefined, chineseScript: ChineseScript) {
  if (!value) {
    return "";
  }

  return chineseScript === "traditional" ? toTraditional(value) : value;
}

function catalogTitle(item: CbetaCatalogItem, chineseScript: ChineseScript) {
  return chineseScript === "traditional" ? item.title : item.titleSimplified ?? item.title;
}

function catalogCanonTitle(item: CbetaCatalogItem, chineseScript: ChineseScript) {
  return chineseScript === "traditional"
    ? item.canonTitle
    : item.canonTitleSimplified ?? item.canonTitle;
}

function workTitle(work: SutraWork, chineseScript: ChineseScript) {
  if (chineseScript === "simplified") {
    return work.title;
  }

  const index = catalogIndexForWork(work);
  const catalogItem = index === undefined ? undefined : cbetaCatalog[index];
  return catalogItem?.title ?? displayText(work.title, chineseScript);
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
  mapGroups: {
    alignItems: "flex-start",
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "center",
    maxWidth: 350,
    width: "100%",
  },
  categoryCard: {
    alignItems: "center",
    alignSelf: "flex-start",
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "31%",
    justifyContent: "center",
    overflow: "hidden",
    paddingHorizontal: 8,
    position: "relative",
  },
  categoryCardCurrent: {
    borderWidth: 2,
  },
  categoryCardFill: {
    bottom: 0,
    left: 0,
    opacity: 0.18,
    position: "absolute",
    top: 0,
  },
  categoryCardTitle: {
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0,
    lineHeight: 24,
    textAlign: "center",
  },
  categoryCardMeta: {
    fontSize: 13,
    fontWeight: "700",
    marginTop: 4,
  },
  categoryDetailMeta: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
    textAlign: "center",
  },
  categoryDetailBar: {
    alignSelf: "center",
    borderRadius: 5,
    height: 10,
    marginBottom: 14,
    maxWidth: 260,
    overflow: "hidden",
    width: "72%",
  },
  categoryDetailBarFill: {
    borderRadius: 5,
    height: 10,
  },
  categoryDotMap: {
    alignContent: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    paddingBottom: 26,
    rowGap: 5,
  },
  categoryActions: {
    alignItems: "center",
    marginTop: 16,
    width: "100%",
  },
  segmentWorkPanel: {
    marginTop: 18,
    width: "100%",
  },
  segmentWorkTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  segmentWorkRow: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 58,
    paddingVertical: 10,
  },
  segmentWorkCopy: {
    flex: 1,
  },
  segmentWorkName: {
    fontSize: 16,
    fontWeight: "700",
  },
  segmentWorkMeta: {
    fontSize: 13,
    marginTop: 4,
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
  bookmarkDetails: {
    flex: 1,
    gap: 6,
  },
  bookmarkMeta: {
    alignItems: "flex-end",
    gap: 6,
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
    minWidth: 92,
  },
  readerTopActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  iconButton: {
    alignItems: "center",
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  searchGlyphBox: {
    height: 22,
    position: "relative",
    width: 22,
  },
  searchGlyphCircle: {
    borderRadius: 7,
    borderWidth: 2,
    height: 14,
    left: 2,
    position: "absolute",
    top: 2,
    width: 14,
  },
  searchGlyphHandle: {
    borderRadius: 1,
    height: 9,
    left: 15,
    position: "absolute",
    top: 14,
    transform: [{ rotate: "-45deg" }],
    width: 2,
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
  readerSearchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  readerSearchInput: {
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    fontSize: 16,
    minHeight: 40,
    paddingHorizontal: 10,
  },
  readerSearchButton: {
    alignItems: "center",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 12,
  },
  readerSearchButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  readerSearchStatus: {
    fontSize: 12,
    minWidth: 42,
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
  readerWebView: {
    flex: 1,
  },
  readerLoading: {
    alignItems: "center",
    flex: 1,
    gap: 10,
    justifyContent: "center",
  },
  readerLoadingText: {
    fontSize: 14,
    fontWeight: "700",
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
