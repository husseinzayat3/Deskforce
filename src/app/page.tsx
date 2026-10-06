import { SimulationProvider } from '../lib/SimulationContext';
import OfficeSimulation from '../components/OfficeSimulation';
import Dashboard from '../components/Dashboard';
import styles from './page.module.css';

export default function Home() {
  return (
    <SimulationProvider>
      <main className={styles.main}>
        <Dashboard />
        <div className={styles.canvasContainer}>
          <div className={styles.canvasWrapper}>
             <OfficeSimulation />
          </div>
        </div>
      </main>
    </SimulationProvider>
  );
}
