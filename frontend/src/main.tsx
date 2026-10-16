import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './commerce.css';
import './studio-refresh.css';
import './liquid-glass.css';
import '../public/theme.css';
import { ThemeProvider } from './theme';

createRoot(document.getElementById('root')!).render(<ThemeProvider><App /></ThemeProvider>);
