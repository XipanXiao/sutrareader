import AsyncStorage from "@react-native-async-storage/async-storage";
import { ReaderState } from "../types";

const storageKey = "sutrareader.readerState.v1";

const emptyState: ReaderState = {
  bookmarks: [],
  readRanges: [],
};

export const loadReaderState = async (): Promise<ReaderState> => {
  const raw = await AsyncStorage.getItem(storageKey);
  if (!raw) {
    return emptyState;
  }

  try {
    return { ...emptyState, ...JSON.parse(raw) };
  } catch {
    return emptyState;
  }
};

export const saveReaderState = async (state: ReaderState) => {
  await AsyncStorage.setItem(storageKey, JSON.stringify(state));
};

export const resetReaderState = async () => {
  await AsyncStorage.removeItem(storageKey);
};
