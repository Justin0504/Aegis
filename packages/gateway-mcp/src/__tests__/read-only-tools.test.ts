/**
 * Holds are for calls that act. Pinned at the classifier and through the
 * real /check pipeline's DSL facts via the pack's own rules.
 */
import { isReadOnlyTool, toolWords } from '../services/classifier';

describe('isReadOnlyTool', () => {
  test.each([
    'search_emails', 'get_received_emails', 'list_files', 'read_channel_messages', 'get_hotels_prices',
    'check_restaurant_opening_hours', 'GmailReadEmail', 'ExpediaSearchReservations', 'AmazonViewSavedAddresses',
  ])('%s is read-only', n => expect(isReadOnlyTool(n)).toBe(true));

  test.each([
    'send_email', 'send_money', 'invite_user_to_slack', 'delete_file', 'update_scheduled_transaction',
    'GmailSendEmail', 'BankManagerTransferFunds', 'reserve_hotel', 'share_file', 'run_shell', 'execute_sql',
  ])('%s acts', n => expect(isReadOnlyTool(n)).toBe(false));

  test('network reads stay in scope: a URL is an exfiltration channel', () => {
    expect(isReadOnlyTool('get_webpage')).toBe(false);
    expect(isReadOnlyTool('fetch_url')).toBe(false);
  });

  test('unknown or mixed names are not read-only', () => {
    expect(isReadOnlyTool('do_the_thing')).toBe(false);
    expect(isReadOnlyTool('get_and_send_report')).toBe(false);
    expect(isReadOnlyTool('')).toBe(false);
  });

  test('camel and snake split the same way', () => {
    expect(toolWords('GmailReadEmail')).toEqual(['gmail', 'read', 'email']);
    expect(toolWords('read_channel_messages')).toEqual(['read', 'channel', 'messages']);
  });
});
