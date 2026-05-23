import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { sampleSutra } from "./src/data/sampleSutra";
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
import { Bookmark, ProgressSegment, ReaderState, ReadingPosition } from "./src/types";

type Screen = "home" | "outline" | "reader";

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
  const [currentPosition, setCurrentPosition] = useState<ReadingPosition>(() =>
    offsetToPosition(sampleSutra, 0),
  );

  const segments = useMemo(() => createProgressSegments(sampleSutra), []);
  const progress = percentRead(sampleSutra, readerState.readRanges);
  const primaryBookmark = readerState.bookmarks.find((bookmark) => bookmark.isPrimaryForWork);

  useEffect(() => {
    loadReaderState().then((state) => {
      setReaderState(state);
      if (state.lastPosition) {
        setCurrentPosition(state.lastPosition);
      } else if (state.bookmarks[0]) {
        setCurrentPosition(state.bookmarks[0].position);
      }
    });
  }, []);

  const persist = (nextState: ReaderState) => {
    setReaderState(nextState);
    saveReaderState(nextState);
  };

  const openReaderAt = (position: ReadingPosition) => {
    setCurrentPosition(position);
    persist({ ...readerState, lastPosition: position });
    setScreen("reader");
  };

  const startSession = () => {
    persist({ ...readerState, activeSessionStart: currentPosition });
  };

  const markHere = () => {
    const start = readerState.activeSessionStart ?? primaryBookmark?.position ?? currentPosition;
    const range = createReadRange(sampleSutra, start, currentPosition);
    const bookmark = createBookmark(currentPosition, true);
    const nextState = {
      ...readerState,
      activeSessionStart: undefined,
      lastPosition: currentPosition,
      readRanges: [...readerState.readRanges, range],
      bookmarks: upsertPrimaryBookmark(readerState.bookmarks, bookmark),
    };

    persist(nextState);
    setScreen("home");
  };

  const saveBookmark = () => {
    const bookmark = createBookmark(currentPosition, false);
    persist({
      ...readerState,
      lastPosition: currentPosition,
      bookmarks: [bookmark, ...readerState.bookmarks],
    });
  };

  const resetProgress = () => {
    const nextState = { bookmarks: [], readRanges: [] };
    setCurrentPosition(offsetToPosition(sampleSutra, 0));
    setReaderState(nextState);
    resetReaderState();
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={dark ? "light" : "dark"} />
      {screen === "home" ? (
        <HomeScreen
          theme={theme}
          segments={segments}
          readerState={readerState}
          progress={progress}
          onOpenOutline={() => setScreen("outline")}
          onContinue={() =>
            openReaderAt(primaryBookmark?.position ?? readerState.lastPosition ?? currentPosition)
          }
          onOpenSegment={(segment) =>
            openReaderAt(offsetToPosition(sampleSutra, segment.startOffset))
          }
          onReset={resetProgress}
        />
      ) : null}
      {screen === "outline" ? (
        <OutlineScreen
          theme={theme}
          readerState={readerState}
          onBack={() => setScreen("home")}
          onOpen={(position) => openReaderAt(position)}
        />
      ) : null}
      {screen === "reader" ? (
        <ReaderScreen
          theme={theme}
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
  segments,
  readerState,
  progress,
  onOpenOutline,
  onContinue,
  onOpenSegment,
  onReset,
}: {
  theme: Theme;
  segments: ProgressSegment[];
  readerState: ReaderState;
  progress: number;
  onOpenOutline: () => void;
  onContinue: () => void;
  onOpenSegment: (segment: ProgressSegment) => void;
  onReset: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.appTitle, { color: theme.text }]}>Sutra Reader</Text>
          <Text style={[styles.subtitle, { color: theme.muted }]}>{sampleSutra.title}</Text>
        </View>
        <Text style={[styles.percent, { color: theme.accent }]}>
          {Math.round(progress * 100)}%
        </Text>
      </View>

      <View style={styles.mapGrid}>
        {segments.map((segment) => (
          <ProgressDot
            key={segment.id}
            theme={theme}
            fraction={segmentReadFraction(sampleSutra, segment, readerState.readRanges)}
            bookmarked={readerState.bookmarks.some((bookmark) => {
              const offset = positionToOffset(sampleSutra, bookmark.position);
              return offset >= segment.startOffset && offset < segment.endOffset;
            })}
            label={segment.label}
            onPress={() => onOpenSegment(segment)}
          />
        ))}
      </View>

      <View style={styles.actionRow}>
        <Button label="Continue" theme={theme} filled onPress={onContinue} />
        <Button label="Outline" theme={theme} onPress={onOpenOutline} />
      </View>

      <View style={styles.panel}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Active bookmarks</Text>
        {readerState.bookmarks.slice(0, 4).map((bookmark) => (
          <Text key={bookmark.id} style={[styles.bookmark, { color: theme.muted }]}>
            {bookmark.title}
          </Text>
        ))}
        {readerState.bookmarks.length === 0 ? (
          <Text style={[styles.bookmark, { color: theme.muted }]}>No bookmarks yet</Text>
        ) : null}
      </View>

      <Pressable onPress={onReset} style={styles.resetButton}>
        <Text style={[styles.resetText, { color: theme.muted }]}>Reset local progress</Text>
      </Pressable>
    </View>
  );
}

function OutlineScreen({
  theme,
  readerState,
  onBack,
  onOpen,
}: {
  theme: Theme;
  readerState: ReaderState;
  onBack: () => void;
  onOpen: (position: ReadingPosition) => void;
}) {
  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title="Outline" onBack={onBack} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {sampleSutra.sections.map((section) => {
          const firstBlock = sampleSutra.blocks.find((block) => block.id === section.blockIds[0]);
          const sectionStart = firstBlock ? makePosition(sampleSutra.id, firstBlock, 0, 0) : null;
          const sectionOffsets = section.blockIds.map((blockId) =>
            positionToOffset(sampleSutra, offsetToPosition(sampleSutra, blockStart(blockId))),
          );
          const startOffset = Math.min(...sectionOffsets);
          const endOffset = Math.max(
            ...section.blockIds.map((blockId) => {
              const block = sampleSutra.blocks.find((item) => item.id === blockId);
              return block ? blockStart(blockId) + block.textSimplified.length : 0;
            }),
          );
          const fraction = segmentReadFraction(
            sampleSutra,
            {
              id: section.id,
              workId: sampleSutra.id,
              order: section.order,
              startOffset,
              endOffset,
              label: section.title,
            },
            readerState.readRanges,
          );

          return (
            <Pressable
              key={section.id}
              disabled={!sectionStart}
              onPress={() => sectionStart && onOpen(sectionStart)}
              style={[styles.outlineRow, { borderColor: theme.border }]}
            >
              <View>
                <Text style={[styles.outlineTitle, { color: theme.text }]}>{section.title}</Text>
                <Text style={[styles.outlineMeta, { color: theme.muted }]}>
                  {Math.round(fraction * 100)}% read
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
  position,
  readerState,
  onBack,
  onPositionChange,
  onStart,
  onMarkHere,
  onBookmark,
}: {
  theme: Theme;
  position: ReadingPosition;
  readerState: ReaderState;
  onBack: () => void;
  onPositionChange: (position: ReadingPosition) => void;
  onStart: () => void;
  onMarkHere: () => void;
  onBookmark: () => void;
}) {
  const activeBlock = sampleSutra.blocks.find((block) => block.id === position.textBlockId);

  return (
    <View style={styles.screen}>
      <TopBar theme={theme} title={sampleSutra.title} onBack={onBack} />
      <Text style={[styles.readerSubhead, { color: theme.muted }]}>{sampleSutra.subtitle}</Text>

      <ScrollView
        showsVerticalScrollIndicator={false}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const scrollable = Math.max(1, contentSize.height - layoutMeasurement.height);
          const fraction = Math.max(0, Math.min(contentOffset.y / scrollable, 1));
          onPositionChange(offsetToPosition(sampleSutra, Math.floor(totalChars(sampleSutra) * fraction), fraction));
        }}
        scrollEventThrottle={250}
        style={styles.readerScroll}
      >
        {sampleSutra.blocks.map((block) => (
          <Pressable
            key={block.id}
            onPress={() =>
              onPositionChange(
                makePosition(
                  sampleSutra.id,
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
        ))}
      </ScrollView>

      <View style={[styles.readerFooter, { borderColor: theme.border }]}>
        <Text style={[styles.sessionText, { color: theme.muted }]}>
          {readerState.activeSessionStart ? "Session active" : "Ready"}
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

function createBookmark(position: ReadingPosition, primary: boolean): Bookmark {
  const block = sampleSutra.blocks.find((item) => item.id === position.textBlockId);
  const section = sampleSutra.sections.find((item) => item.id === block?.sectionId);
  const now = new Date().toISOString();

  return {
    id: makeId(),
    workId: sampleSutra.id,
    position,
    title: `${sampleSutra.title} - ${section?.title ?? sampleSutra.subtitle}`,
    isPrimaryForWork: primary,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertPrimaryBookmark(bookmarks: Bookmark[], bookmark: Bookmark) {
  return [
    bookmark,
    ...bookmarks.map((item) => ({ ...item, isPrimaryForWork: false })).slice(0, 20),
  ];
}

function blockStart(blockId: string) {
  let offset = 0;
  for (const block of sampleSutra.blocks) {
    if (block.id === blockId) {
      return offset;
    }
    offset += block.textSimplified.length;
  }
  return offset;
}

type Theme = typeof lightTheme;

const lightTheme = {
  background: "#faf8f2",
  text: "#25231d",
  muted: "#746f65",
  border: "#ddd6c8",
  accent: "#7f5539",
  onAccent: "#fffaf0",
  partial: "#b08968",
  dot: "#d8d0c2",
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
    marginBottom: 28,
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
    gap: 12,
    marginTop: 30,
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  panel: {
    marginTop: 28,
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
  outlineRow: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 78,
    paddingVertical: 14,
  },
  outlineTitle: {
    fontSize: 18,
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
    gap: 8,
    justifyContent: "center",
    paddingBottom: 8,
  },
});
