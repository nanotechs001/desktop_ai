/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Result, Spin } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { reconnectWs } from '@/common/adapter/httpBridge';
import { useAuth } from '@renderer/hooks/context/AuthContext';

type QrLoginState = 'signingIn' | 'expired';
type WindowWithReconnect = Window & { __websocketReconnect?: () => void };

/**
 * Landing page for the sign-in QR code: trades the one-time token in the URL for a session.
 * Any failure reads as an expired code, since the token is single-use and short-lived.
 */
const QrLoginPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refresh, status } = useAuth();
  const token = useSearchParams()[0].get('token');
  const [state, setState] = useState<QrLoginState>(token ? 'signingIn' : 'expired');
  // The token is single-use, so a re-run of the effect must not spend it twice.
  const startedRef = useRef(false);
  // Read through a ref so a status change never re-runs the effect.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!token || startedRef.current) return;
    startedRef.current = true;
    // Already signed in (e.g. the page reloaded on this URL): the token is spent, just go home.
    if (statusRef.current === 'authenticated') {
      void navigate('/', { replace: true });
      return;
    }

    // A session that appeared meanwhile wins over the spent code.
    const showExpiredUnlessSignedIn = () => {
      if (statusRef.current === 'authenticated') void navigate('/', { replace: true });
      else setState('expired');
    };

    const signIn = async () => {
      try {
        const response = await fetch('/api/auth/qr-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ qr_token: token }),
        });
        if (!response.ok) {
          showExpiredUnlessSignedIn();
          return;
        }
        await refresh();
        // Re-enable WebSocket reconnection after a successful sign-in, as the password login does.
        (window as WindowWithReconnect).__websocketReconnect?.();
        reconnectWs();
        void navigate('/', { replace: true });
      } catch (error) {
        console.error('QR login request failed:', error);
        showExpiredUnlessSignedIn();
      }
    };
    void signIn();
  }, [navigate, refresh, token]);

  return (
    <div className='flex items-center justify-center min-h-100vh bg-base'>
      {state === 'signingIn' ? (
        <Spin tip={t('login.qrSigningIn')} />
      ) : (
        <Result
          status='warning'
          title={t('login.qrExpired')}
          extra={
            <Button type='primary' onClick={() => void navigate('/login', { replace: true })}>
              {t('login.qrBackToLogin')}
            </Button>
          }
        />
      )}
    </div>
  );
};

export default QrLoginPage;
