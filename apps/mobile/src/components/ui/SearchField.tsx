import type { RefObject } from "react";
import { Pressable, TextInput, type TextInputInstance, View } from "react-native";

import { SymbolView } from "./AppSymbol";

export interface SearchFieldProps {
  readonly autoFocus?: boolean;
  readonly inputRef: RefObject<TextInputInstance | null>;
  readonly accessibilityLabel: string;
  readonly clearAccessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
}

export function SearchField({
  inputRef,
  autoFocus = true,
  accessibilityLabel,
  clearAccessibilityLabel,
  placeholder,
  value,
  onChangeText,
}: SearchFieldProps) {
  return (
    <View
      className="min-w-0 flex-1 flex-row items-center rounded-full border border-input-border bg-input"
      style={{
        minHeight: 48,
        gap: 7,
        paddingHorizontal: 10.5,
      }}
    >
      <SymbolView name="magnifyingglass" size={18} tintColorClassName="accent-foreground-muted" />
      <TextInput
        ref={inputRef}
        accessibilityLabel={accessibilityLabel}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        selectionHandleColorClassName="accent-focus"
        className="min-w-0 flex-1 font-sans text-base text-foreground"
        style={{ paddingVertical: 7 }}
        value={value}
        onChangeText={onChangeText}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityLabel={clearAccessibilityLabel}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => {
            onChangeText("");
            inputRef.current?.focus();
          }}
        >
          <SymbolView
            name="xmark.circle.fill"
            size={18}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
