import { faCircleHalfStroke, faMoon, faSun  } from "@fortawesome/free-solid-svg-icons";
import { Theme } from "./interfaces/theme";


export const Themes: Theme[] = [
  {
    id: 'light',
    displayName: 'Claro',
    icon: faSun,
  },
  {
    id: 'dark',
    displayName: 'Escuro',
    icon: faMoon,
  },
  {
    id: 'auto',
    displayName: 'Automático',
    icon: faCircleHalfStroke,
  },
];
