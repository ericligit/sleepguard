import React from 'react';
import {View, Text} from 'react-native';
// ErrorBoundary kept intentionally — surfaces JS crashes as readable text instead of blank screen
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {HomeScreen} from '../screens/HomeScreen';
import {SessionDetailScreen} from '../screens/SessionDetailScreen';
import type {RootStackParamList} from '../types';

const Stack = createNativeStackNavigator<RootStackParamList>();

class ErrorBoundary extends React.Component<
  {children: React.ReactNode},
  {error: string | null}
> {
  state = {error: null};
  componentDidCatch(e: Error) {
    this.setState({error: e.message + '\n' + e.stack});
    console.error('[SleepGuard] Render crash:', e.message, e.stack);
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{flex: 1, backgroundColor: '#0D1B2A', padding: 20, justifyContent: 'center'}}>
          <Text style={{color: '#EF5350', fontSize: 14, fontFamily: 'monospace'}}>
            {this.state.error}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export const AppNavigator: React.FC = () => (
  <ErrorBoundary>
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {backgroundColor: '#0D1B2A'},
          headerTintColor: '#FFFFFF',
          headerTitleStyle: {fontWeight: '600'},
          contentStyle: {backgroundColor: '#0D1B2A'},
        }}>
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{headerShown: false}}
        />
        <Stack.Screen
          name="SessionDetail"
          component={SessionDetailScreen}
          options={{title: 'Session Details'}}
        />
      </Stack.Navigator>
    </NavigationContainer>
  </ErrorBoundary>
);
