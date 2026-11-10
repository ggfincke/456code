import { useNavigation } from "@react-navigation/native";

/** The page's Back action. */
export function useSettingsPageBack() {
  const navigation = useNavigation();
  return () => navigation.goBack();
}
