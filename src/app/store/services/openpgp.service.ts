import { Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  ChangePassphraseSuccess, ClearContactsToDecrypt,
  ContactAdd, ContactDecryptSuccess, ContactsGet,
  GetMailboxesSuccess,
  Logout,
  SetDecryptedKey,
  SetDecryptInProgress, UpdateBatchContacts,
  UpdatePGPDecryptedContent,
  UpdatePGPEncryptedContent,
  UpdatePGPSshKeys,
  UpdateSecureMessageContent,
  UpdateSecureMessageEncryptedContent,
  UpdateSecureMessageKey
} from '../actions';
import { AppState, AuthState, Contact, ContactsState, MailBoxesState, SecureContent, Settings, UserState } from '../datatypes';
import { UsersService } from './users.service';
import { Mailbox } from '../models';
import { PRIMARY_DOMAIN } from '../../shared/config';
import { untilDestroyed } from 'ngx-take-until-destroy';

@Injectable()
export class OpenPgpService {
  options: any;
  encrypted: any;
  private pubkeys: any;
  private pubkeysArray: Array<string> = [];
  private primaryMailbox: Mailbox;
  private privkeys: any;
  private decryptedPrivKeys: any;
  private decryptInProgress: boolean;
  private pgpWorker: Worker;
  private isAuthenticated: boolean;
  private userKeys: any;
  private mailboxes: Mailbox[];
  private userSettings: Settings;
  private contactsState: ContactsState;

  constructor(private store: Store<AppState>,
              private usersService: UsersService) {

    this.pgpWorker = new Worker('/assets/static/pgp-worker.js');
    this.listenWorkerPostMessages();

    this.store.select(state => state.mailboxes)
      .subscribe((mailBoxesState: MailBoxesState) => {
        if (mailBoxesState.mailboxes.length > 0) {
          this.mailboxes = mailBoxesState.mailboxes;
          this.privkeys = this.privkeys || {};
          this.pubkeys = this.pubkeys || {};
          let hasNewPrivateKey = false;
          mailBoxesState.mailboxes.forEach(mailbox => {
            if (!this.privkeys[mailbox.id]) {
              this.privkeys[mailbox.id] = mailbox.private_key;
              hasNewPrivateKey = true;
            }
            if (!this.pubkeys[mailbox.id]) {
              this.pubkeys[mailbox.id] = mailbox.public_key;
              this.pubkeysArray.push(mailbox.public_key);
            }
            if (mailbox.is_default && !this.primaryMailbox) {
              this.primaryMailbox = mailbox;
            }
          });
          if (hasNewPrivateKey) {
            this.decryptPrivateKeys();
          }
        }
        this.decryptInProgress = mailBoxesState.decryptKeyInProgress;
      });

    this.store.select((state: AppState) => state.auth)
      .subscribe((authState: AuthState) => {
        if (this.isAuthenticated && !authState.isAuthenticated) {
          this.clearData();
        }
        this.isAuthenticated = authState.isAuthenticated;
      });
    this.store.select((state: AppState) => state.user)
      .subscribe((userState: UserState) => {
        this.userSettings = userState.settings;
      });
  }

  decryptPrivateKeys(privKeys?: any, password?: string) {
    const userKey = password ? btoa(password) : this.usersService.getUserKey();
    if (!userKey) {
      this.store.dispatch(new Logout());
      return;
    }
    this.privkeys = privKeys ? privKeys : this.privkeys;
    this.store.dispatch(new SetDecryptInProgress(true));

    this.pgpWorker.postMessage({
      decryptPrivateKeys: true,
      privkeys: Object.keys(this.privkeys).map(key => ({ mailboxId: key, privkey: this.privkeys[key] })),
      user_key: atob(userKey)
    });
  }

  listenWorkerPostMessages() {
    this.pgpWorker.onmessage = ((event: MessageEvent) => {
      if (event.data.generateKeys) {
        if (event.data.forEmail) {
          this.store.dispatch(new UpdatePGPSshKeys({
            isSshInProgress: false,
            keys: event.data.keys,
            draftId: event.data.callerId
          }));
        } else {
          this.userKeys = event.data.keys;
        }
      } else if (event.data.decryptPrivateKeys) {
        this.decryptedPrivKeys = event.data.keys;
        this.store.dispatch(new SetDecryptedKey({ decryptedKey: this.decryptedPrivKeys }));
      } else if (event.data.decrypted) {
        this.store.dispatch(new UpdatePGPDecryptedContent({
          id: event.data.callerId,
          isPGPInProgress: false,
          decryptedContent: event.data.decryptedContent,
          isDecryptingAllSubjects: event.data.isDecryptingAllSubjects
        }));
      } else if (event.data.decryptSecureMessageKey) {
        this.store.dispatch(new UpdateSecureMessageKey({
          decryptedKey: event.data.decryptedKey,
          inProgress: false,
          error: event.data.error
        }));
      } else if (event.data.decryptSecureMessageContent) {
        this.store.dispatch(new UpdateSecureMessageContent({ decryptedContent: event.data.mailData, inProgress: false }));
      } else if (event.data.changePassphrase) {
        event.data.keys.forEach(item => {
          item.public_key = item.public_key ? item.public_key : this.pubkeys[item.mailbox_id];
        });
        this.store.dispatch(new ChangePassphraseSuccess(event.data.keys));
      } else if (event.data.encrypted) {
        this.store.dispatch(new UpdatePGPEncryptedContent({
          isPGPInProgress: false,
          encryptedContent: event.data.encryptedContent,
          draftId: event.data.callerId
        }));
      } else if (event.data.encryptSecureMessageReply) {
        this.store.dispatch(new UpdateSecureMessageEncryptedContent({
          inProgress: false,
          encryptedContent: event.data.encryptedContent
        }));
      } else if (event.data.encryptJson) {
        if (event.data.isAddContact) {
          this.store.dispatch(new ContactAdd({
            id: event.data.id,
            encrypted_data: event.data.encryptedContent,
            is_encrypted: true
          }));
        }
      } else if (event.data.decryptJson) {
        if (event.data.isContact) {
          this.store.dispatch(new ContactDecryptSuccess({ ...JSON.parse(event.data.content), id: event.data.id }));
        } else if (event.data.isContactsArray) {
          const totalDecryptedContacts = this.contactsState.noOfDecryptedContacts + event.data.contacts.length;
          this.store.dispatch(new UpdateBatchContacts({ contact_list: event.data.contacts }));
          if (this.contactsState.totalContacts > totalDecryptedContacts) {
            this.store.dispatch(new ContactsGet({
              limit: 20,
              offset: totalDecryptedContacts,
              isDecrypting: true,
            }));
          }
        }
      }
    });
  }

  encrypt(mailboxId, draftId, mailData: SecureContent, publicKeys: any[] = []) {
    this.store.dispatch(new UpdatePGPEncryptedContent({ isPGPInProgress: true, encryptedContent: {}, draftId }));

    publicKeys.push(this.pubkeys[mailboxId]);
    if (this.userSettings && !this.userSettings.is_subject_encrypted) {
      mailData.subject = null;
    }
    this.pgpWorker.postMessage({ mailData, publicKeys, encrypt: true, callerId: draftId });
  }

  encryptContact(contact: Contact, isAddContact = true) {
    contact.is_encrypted = true;
    const content = JSON.stringify(contact);
    this.pgpWorker.postMessage({
      content,
      isAddContact,
      email: contact.email,
      publicKeys: this.pubkeysArray,
      encryptJson: true,
      id: contact.id
    });
  }

  decryptContact(content: string, id: number) {
    if (this.decryptedPrivKeys) {
      this.pgpWorker.postMessage({ id, content, mailboxId: this.primaryMailbox.id, decryptJson: true, isContact: true });
    } else {
      setTimeout(() => {
        this.decryptContact(content, id);
      }, 1000);
    }
  }

  encryptSecureMessageContent(content, publicKeys: any[]) {
    this.store.dispatch(new UpdateSecureMessageEncryptedContent({ inProgress: true, encryptedContent: null }));

    this.pgpWorker.postMessage({ content, publicKeys, encryptSecureMessageReply: true });
  }

  decrypt(mailboxId, mailId, mailData: SecureContent, isDecryptingAllSubjects: boolean = false) {
    if (this.decryptedPrivKeys) {
      if (!mailData.isSubjectEncrypted) {
        mailData.subject = null;
      }
      this.store.dispatch(new UpdatePGPDecryptedContent({
        isDecryptingAllSubjects,
        id: mailId,
        isPGPInProgress: true,
        decryptedContent: {}
      }));
      this.pgpWorker.postMessage({ mailboxId, mailData, isDecryptingAllSubjects, decrypt: true, callerId: mailId });
    } else {
      setTimeout(() => {
        this.decrypt(mailboxId, mailId, mailData);
      }, 1000);
    }
  }

  decryptSecureMessagePrivKey(privKey: string, password: string) {
    this.pgpWorker.postMessage({ decryptSecureMessageKey: true, privKey, password });
    this.store.dispatch(new UpdateSecureMessageKey({ decryptedKey: null, inProgress: true }));
  }

  decryptSecureMessageContent(decryptedKey: any, mailData: SecureContent) {
    if (!mailData.isSubjectEncrypted) {
      mailData.subject = null;
    }
    this.pgpWorker.postMessage({ decryptSecureMessageContent: true, decryptedKey, mailData });
    this.store.dispatch(new UpdateSecureMessageContent({ decryptedContent: null, inProgress: true }));
  }

  clearData(publicKeys?: any) {
    this.decryptedPrivKeys = null;
    this.pubkeys = null;
    this.privkeys = null;
    this.userKeys = null;
    this.primaryMailbox = null;
    this.store.dispatch(new SetDecryptedKey({ decryptedKey: null }));
    this.pgpWorker.postMessage({ clear: true });

    if (publicKeys) {
      this.mailboxes.forEach(item => {
        item.public_key = publicKeys[item.id];
      });
      this.store.dispatch(new GetMailboxesSuccess(this.mailboxes));
    }
  }

  generateUserKeys(username: string, password: string, domain: string = PRIMARY_DOMAIN) {
    if (username.split('@').length > 1) {
      domain = username.split('@')[1];
      username = username.split('@')[0];
    }
    this.userKeys = null;
    const options = {
      userIds: [{ name: `${username}_${domain}`, email: `${username}@${domain}` }],
      numBits: 4096,
      passphrase: password
    };
    this.pgpWorker.postMessage({ options, generateKeys: true });
  }

  generateEmailSshKeys(password: string, draftId: number) {
    this.store.dispatch(new UpdatePGPSshKeys({ isSshInProgress: true, sshKeys: null, draftId }));
    const options = {
      userIds: [{ name: `${draftId}` }],
      numBits: 4096,
      passphrase: password
    };
    this.pgpWorker.postMessage({ options, generateKeys: true, forEmail: true, callerId: draftId });
  }

  getUserKeys() {
    return this.userKeys;
  }

  waitForPGPKeys(self: any, callbackFn: string) {
    setTimeout(() => {
      if (this.getUserKeys()) {
        self[callbackFn]();
        return;
      }
      this.waitForPGPKeys(self, callbackFn);
    }, 500);
  }

  changePassphrase(passphrase: string, deleteData: boolean, username: string) {
    this.pgpWorker.postMessage({ passphrase, deleteData, username, mailboxes: this.mailboxes, changePassphrase: true });
  }

  revertChangedPassphrase(passphrase: string, deleteData: boolean) {
    if (!deleteData) {
      this.pgpWorker.postMessage({ passphrase, revertPassphrase: true });
    }
  }

  decryptAllContacts() {
    if (!this.contactsState) {
      this.store.select(state => state.contacts)
        .subscribe((contactsState: ContactsState) => {
          this.contactsState = contactsState;
          if (contactsState.contactsToDecrypt.length > 0) {
            this.store.dispatch(new ClearContactsToDecrypt());
            const contacts = this.contactsState.contacts.filter(contact => contact.is_encrypted);
            this.pgpWorker.postMessage({ contacts, mailboxId: this.primaryMailbox.id, decryptJson: true, isContactsArray: true });
          }
        });
    }
  }

}
