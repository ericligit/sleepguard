import React, {useEffect} from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AppNavigator} from './src/navigation/AppNavigator';
import {initDatabase} from './src/services/database';

function App(): React.JSX.Element {
  useEffect(() => {
    initDatabase().catch(err =>
      console.error('[SleepGuard] Database init failed:', err),
    );
  }, []);

  return (
    <SafeAreaProvider>
      <AppNavigator />
    </SafeAreaProvider>
  );
}

export default App;
