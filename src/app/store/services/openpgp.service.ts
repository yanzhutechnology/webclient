import { Store } from '@ngrx/store';
import { Observable, Subject } from 'rxjs';
import { Injectable } from '@angular/core';

import { PRIMARY_DOMAIN } from '../../shared/config';
import {
  ChangePassphraseSuccess,
  ClearContactsToDecrypt,
  ContactAdd,
  ContactDecryptSuccess,
  ContactsGet,
  FetchMailboxKeysSuccess,
  GetMailboxesSuccess,
  Logout,
  SetDecryptedKey,
  SetDecryptInProgress,
  StartAttachmentEncryption,
  UpdateBatchContacts,
  UpdatePGPDecryptedContent,
  UpdatePGPEncryptedContent,
  UpdatePGPMimeEncrytion,
  UpdatePGPSshKeys,
  UpdateSecureMessageContent,
  UpdateSecureMessageEncryptedContent,
  UpdateSecureMessageKey,
  UploadAttachment,
} from '../actions';
import {
  AppState,
  AuthState,
  Contact,
  ContactsState,
  MailBoxesState,
  PGPEncryptionType,
  SecureContent,
  Settings,
  UserState,
} from '../datatypes';
import { Attachment, Mailbox, PGPMimeMessageProgressModel } from '../models';

import { UsersService } from './users.service';

@Injectable()
export class OpenPgpService {
  encrypted: any;

  options: any;

  private contactsState: ContactsState;

  private decryptedAllPrivKeys: any;

  private decryptInProgress: boolean;

  private isAuthenticated: boolean;

  private mailboxes: Mailbox[];

  private pgpWorker: Worker;

  private primaryMailbox: Mailbox;

  private privkeys: any;

  private allPrivateKeys: any;

  private pubkeys: any;

  private pubkeysArray: Array<string> = [];

  private subjects: any = {};

  private userKeys: any;

  private userSettings: Settings;

  private mailboxKeysInProgress: boolean;

  private messageForPGPMimeInProcess: Map<number, PGPMimeMessageProgressModel> = new Map<
    number,
    PGPMimeMessageProgressModel
  >();

  constructor(private store: Store<AppState>, private usersService: UsersService) {
    this.pgpWorker = new Worker('assets/static/pgp-worker.js');
    this.listenWorkerPostMessages();

    this.store
      .select(state => state.mailboxes)
      .subscribe((mailBoxesState: MailBoxesState) => {
        if (mailBoxesState.mailboxes.length > 0) {
          this.mailboxes = mailBoxesState.mailboxes;
          this.allPrivateKeys = this.allPrivateKeys || {};
          this.pubkeys = this.pubkeys || {};
          this.pubkeysArray = [];
          const { mailboxKeysMap } = mailBoxesState;
          mailBoxesState.mailboxes.forEach(mailbox => {
            if (mailboxKeysMap.has(mailbox.id) && mailboxKeysMap.get(mailbox.id).length > 0) {
              this.allPrivateKeys[mailbox.id] = mailboxKeysMap.get(mailbox.id).map(key => key.private_key);
              this.pubkeys[mailbox.id] = mailboxKeysMap.get(mailbox.id).map(key => key.public_key);
              this.pubkeysArray = [...this.pubkeysArray, ...this.pubkeys[mailbox.id]];
            }
            if (mailbox.is_default && !this.primaryMailbox) {
              this.primaryMailbox = mailbox;
            }
          });
          if (this.mailboxKeysInProgress && !mailBoxesState.mailboxKeyInProgress && this.allPrivateKeys) {
            this.decryptAllPrivateKeys();
          }
        }
        this.decryptInProgress = mailBoxesState.decryptKeyInProgress;
        this.mailboxKeysInProgress = mailBoxesState.mailboxKeyInProgress;
      });

    this.store
      .select((state: AppState) => state.auth)
      .subscribe((authState: AuthState) => {
        if (this.isAuthenticated && !authState.isAuthenticated) {
          this.clearData();
        }
        this.isAuthenticated = authState.isAuthenticated;
      });
    this.store
      .select((state: AppState) => state.user)
      .subscribe((userState: UserState) => {
        this.userSettings = userState.settings;
      });
  }

  decryptAllPrivateKeys(privKeys?: any, password?: string) {
    const userKey = password ? btoa(password) : this.usersService.getUserKey();
    if (!userKey) {
      this.store.dispatch(new Logout());
      return;
    }
    this.allPrivateKeys = privKeys || this.allPrivateKeys;
    this.store.dispatch(new SetDecryptInProgress(true));
    this.pgpWorker.postMessage({
      decryptAllPrivateKeys: true,
      privkeys: this.allPrivateKeys,
      user_key: atob(userKey),
    });
  }

  // Encrypt - Decrypt content
  encrypt(
    mailboxId: number,
    draftId: number,
    mailData: SecureContent,
    publicKeys: any[] = [],
    pgpEncryptionTypeForExternal: PGPEncryptionType = null,
  ) {
    this.store.dispatch(new UpdatePGPEncryptedContent({ isPGPInProgress: true, encryptedContent: {}, draftId }));
    const pubKeys = publicKeys.length > 0 ? publicKeys.concat(this.pubkeys[mailboxId]) : this.pubkeys[mailboxId];
    this.pgpWorker.postMessage({
      mailData,
      publicKeys: pubKeys,
      encrypt: true,
      callerId: draftId,
      pgpEncryptionTypeForExternal,
    });
  }

  decryptProcess(
    mailboxId: number,
    mailId: number,
    mailData: SecureContent,
    isDecryptingAllSubjects = false,
    subjectId: number,
    isPGPMime = false,
  ) {
    if (this.decryptedAllPrivKeys) {
      if (!mailData.isSubjectEncrypted) {
        mailData.subject = null;
      }
      this.store.dispatch(
        new UpdatePGPDecryptedContent({
          isDecryptingAllSubjects,
          id: mailId,
          isPGPInProgress: true,
          decryptedContent: {},
        }),
      );
      this.pgpWorker.postMessage({
        mailboxId,
        mailData,
        isDecryptingAllSubjects,
        decrypt: true,
        callerId: mailId,
        subjectId,
        isPGPMime,
      });
    } else {
      setTimeout(() => {
        this.decryptProcess(mailboxId, mailId, mailData, isDecryptingAllSubjects, subjectId, isPGPMime);
      }, 1000);
    }
  }

  decrypt(
    mailboxId: number,
    mailId: number,
    mailData: SecureContent,
    isDecryptingAllSubjects = false,
    isPGPMime = false,
  ) {
    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;
    this.decryptProcess(mailboxId, mailId, mailData, isDecryptingAllSubjects, subjectId, isPGPMime);
    return subject.asObservable();
  }

  // Encrypt - Decrypt Contacts
  encryptContact(contact: Contact, isAddContact = true) {
    contact.is_encrypted = true;
    const content = JSON.stringify(contact);
    this.pgpWorker.postMessage({
      content,
      isAddContact,
      email: contact.email,
      publicKeys: this.pubkeysArray,
      encryptJson: true,
      id: contact.id,
    });
  }

  decryptContact(content: string, id: number) {
    if (this.decryptedAllPrivKeys) {
      this.pgpWorker.postMessage({
        id,
        content,
        mailboxId: this.primaryMailbox.id,
        decryptJson: true,
        isContact: true,
      });
    } else {
      setTimeout(() => {
        this.decryptContact(content, id);
      }, 1000);
    }
  }

  decryptAllContacts() {
    if (!this.contactsState) {
      this.store
        .select(state => state.contacts)
        .subscribe((contactsState: ContactsState) => {
          this.contactsState = contactsState;
          if (contactsState.contactsToDecrypt.length > 0) {
            this.store.dispatch(new ClearContactsToDecrypt());
            const contacts = this.contactsState.contacts.filter(contact => contact.is_encrypted);
            this.pgpWorker.postMessage({
              contacts,
              mailboxId: this.primaryMailbox.id,
              decryptJson: true,
              isContactsArray: true,
            });
          }
        });
    }
  }

  // Encrypt - Decrypt attachment
  encryptAttachment(mailboxId: number, attachment: Attachment, publicKeys: any[] = []) {
    this.store.dispatch(new StartAttachmentEncryption({ ...attachment }));
    publicKeys = publicKeys.length > 0 ? publicKeys.concat(this.pubkeys[mailboxId]) : this.pubkeys[mailboxId];
    const reader = new FileReader();
    reader.addEventListener('load', (event: any) => {
      const buffer = event.target.result;
      const uint8Array = new Uint8Array(buffer);
      this.pgpWorker.postMessage({ fileData: uint8Array, publicKeys, encryptAttachment: true, attachment });
    });
    reader.readAsArrayBuffer(attachment.decryptedDocument);
  }

  decryptAttachment(mailboxId: number, fileData: string, fileInfo: any): Observable<Attachment> {
    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;
    this.pgpWorker.postMessage({ mailboxId, fileData, decryptAttachment: true, fileInfo, subjectId });
    return subject.asObservable();
  }

  clearData(keyMap?: any) {
    this.decryptedAllPrivKeys = null;
    this.pubkeys = null;
    this.privkeys = null;
    this.userKeys = null;
    this.primaryMailbox = null;
    this.store.dispatch(new SetDecryptedKey({ decryptedKey: null }));
    this.pgpWorker.postMessage({ clear: true });

    if (keyMap) {
      this.store.dispatch(new FetchMailboxKeysSuccess({ keyMap, updateKeyMap: true }));
    }
  }

  generateUserKeys(username: string, password: string, domain: string = PRIMARY_DOMAIN) {
    if (username.split('@').length > 1) {
      domain = username.split('@')[1];
      username = username.split('@')[0];
    }
    this.userKeys = null;
    const options = {
      userIds: [{ email: `${username}@${domain}` }],
      numBits: 4096,
      passphrase: password,
    };
    this.pgpWorker.postMessage({ options, generateKeys: true });
  }

  generateEmailSshKeys(password: string, draftId: number) {
    this.store.dispatch(new UpdatePGPSshKeys({ isSshInProgress: true, sshKeys: null, draftId }));
    const options = {
      userIds: [{ name: `${draftId}` }],
      numBits: 4096,
      passphrase: password,
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

  // For encrypting with password - CTemplar's end
  encryptWithOnlyPassword(draftId: number, mailData: SecureContent, password: string) {
    this.store.dispatch(new UpdatePGPEncryptedContent({ isPGPInProgress: true, encryptedContent: {}, draftId }));
    this.pgpWorker.postMessage({ mailData, encryptWithPassword: true, callerId: draftId, password });
  }

  encryptAttachmentWithOnlyPassword(attachment: Attachment, password: string) {
    this.store.dispatch(new StartAttachmentEncryption({ ...attachment }));
    const reader = new FileReader();
    reader.addEventListener('load', (event: any) => {
      const buffer = event.target.result;
      const uint8Array = new Uint8Array(buffer);
      this.pgpWorker.postMessage({ fileData: uint8Array, password, encryptAttachmentWithPassword: true, attachment });
    });
    reader.readAsArrayBuffer(attachment.decryptedDocument);
  }

  // For decrypting password encrypted content - CTemplar's end
  decryptPasswordEncryptedContent(mailboxId: number, mailId: number, mailData: SecureContent, password: string) {
    if (!mailData.isSubjectEncrypted) {
      mailData.subject = null;
    }

    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;

    this.store.dispatch(
      new UpdatePGPDecryptedContent({
        id: mailId,
        isPGPInProgress: true,
        decryptedContent: {},
      }),
    );
    this.pgpWorker.postMessage({
      mailboxId,
      mailData,
      decryptPasswordEncryptedContent: true,
      callerId: mailId,
      password,
      subjectId,
    });
    return subject.asObservable();
  }

  // For encrypting & decrypting password encrypted content - External's end
  encryptSecureMessageContent(content: string, publicKeys: any[]) {
    this.store.dispatch(new UpdateSecureMessageEncryptedContent({ inProgress: true, encryptedContent: null }));
    this.pgpWorker.postMessage({ content, publicKeys, encryptSecureMessageReply: true });
  }

  decryptWithOnlyPassword(mailData: SecureContent, password: string) {
    if (!mailData.isSubjectEncrypted) {
      mailData.subject = null;
    }
    this.pgpWorker.postMessage({ decryptSecureMessageContent: true, password, mailData });
    this.store.dispatch(new UpdateSecureMessageContent({ decryptedContent: null, inProgress: true }));
  }

  decryptAttachmentWithOnlyPassword(fileData: string, fileInfo: any, password: string): Observable<Attachment> {
    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;
    this.pgpWorker.postMessage({
      password,
      fileData,
      decryptSecureMessageAttachment: true,
      fileInfo,
      subjectId,
    });
    return subject.asObservable();
  }

  getKeyInfoFromPublicKey(publicKey: string) {
    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;
    this.pgpWorker.postMessage({ publicKey, getKeyInfoFromPublicKey: true, subjectId });
    return subject.asObservable();
  }

  // Multiple mailbox keys
  generateUserKeysWithEmail(email: string, password: string) {
    const subject = new Subject<any>();
    const subjectId = performance.now();
    this.subjects[subjectId] = subject;
    const options = {
      userIds: [{ email }],
      numBits: 4096,
      passphrase: password,
    };
    this.pgpWorker.postMessage({ options, generateKeysForEmail: true, subjectId });
    return subject.asObservable();
  }

  /**
   * PGP/MIME encryption
   * Try to encrypt everything for PGP/MIME message's content and attachment
   */
  encryptForPGPMime(pgpMimeData: string, mailboxId: number, draftId: number, publicKeys: any[] = []) {
    this.store.dispatch(new UpdatePGPMimeEncrytion({ isPGPMimeInProgress: true, encryptedContent: {}, draftId }));
    if (pgpMimeData) {
      const pubKeys = publicKeys.length > 0 ? publicKeys.concat(this.pubkeys[mailboxId]) : this.pubkeys[mailboxId];
      this.pgpWorker.postMessage({ pgpMimeData, publicKeys: pubKeys, encryptForPGPMimeContent: true, draftId });
    }
  }

  listenWorkerPostMessages() {
    this.pgpWorker.onmessage = (event: MessageEvent) => {
      // Generate Keys
      if (event.data.generateKeys) {
        if (event.data.forEmail) {
          this.store.dispatch(
            new UpdatePGPSshKeys({
              isSshInProgress: false,
              keys: event.data.keys,
              draftId: event.data.callerId,
            }),
          );
        } else {
          this.userKeys = event.data.keys;
        }
      } else if (event.data.decryptAllPrivateKeys) {
        this.decryptedAllPrivKeys = event.data.keys;
        this.store.dispatch(new SetDecryptedKey({ decryptedKey: this.decryptedAllPrivKeys }));
      } else if (event.data.decrypted) {
        // TODO - should be updated while integrating all of decryption logic
        // Currently PGP/MIME message logic is separated with the others
        console.log('==========>>>>>>>>>>>>> done to decrypt', event.data)
        if (event.data.decryptedPGPMime) {
          if (this.subjects[event.data.subjectId]) {
            if (event.data.error) {
              this.subjects[event.data.subjectId].error(event.data);
            } else {
              this.subjects[event.data.subjectId].next(event.data);
              this.subjects[event.data.subjectId].complete();
            }
            delete this.subjects[event.data.subjectId];
          }
        } else {
          this.store.dispatch(
            new UpdatePGPDecryptedContent({
              id: event.data.callerId,
              isPGPInProgress: false,
              decryptedContent: event.data.decryptedContent,
              isDecryptingAllSubjects: event.data.isDecryptingAllSubjects,
              decryptError: event.data.error,
              isSubjectDecryptedError: event.data.isSubjectDecryptedError,
            }),
          );
          if (this.subjects[event.data.subjectId]) {
            if (event.data.error) {
              this.subjects[event.data.subjectId].error();
            } else {
              this.subjects[event.data.subjectId].next();
              this.subjects[event.data.subjectId].complete();
            }
            delete this.subjects[event.data.subjectId];
          }
        }
      } else if (event.data.decryptSecureMessageKey) {
        this.store.dispatch(
          new UpdateSecureMessageKey({
            decryptedKey: event.data.decryptedKey,
            inProgress: false,
            error: event.data.error,
          }),
        );
      } else if (event.data.decryptSecureMessageContent) {
        this.store.dispatch(
          new UpdateSecureMessageContent({ decryptedContent: event.data.mailData, inProgress: false }),
        );
      } else if (event.data.changePassphrase) {
        Object.keys(event.data.keys).forEach(mailboxId => {
          event.data.keys[mailboxId].forEach((key: any, index: number) => {
            key.public_key = key.public_key ? key.public_key : this.pubkeys[mailboxId][index];
          });
        });
        this.store.dispatch(new ChangePassphraseSuccess(event.data.keys));
      } else if (event.data.encrypted) {
        this.store.dispatch(
          new UpdatePGPEncryptedContent({
            isPGPInProgress: false,
            encryptedContent: event.data.encryptedContent,
            draftId: event.data.callerId,
          }),
        );
      } else if (event.data.encryptedAttachment) {
        const oldDocument = event.data.attachment.decryptedDocument;
        const newDocument = new File([event.data.encryptedContent], oldDocument.name, {
          type: oldDocument.type,
          lastModified: oldDocument.lastModified,
        });
        const attachment: Attachment = { ...event.data.attachment, document: newDocument, is_encrypted: true };
        this.store.dispatch(new UploadAttachment({ ...attachment }));
      } else if (event.data.decryptedAttachment || event.data.decryptedSecureMessageAttachment) {
        const array = event.data.decryptedContent;
        const newDocument = new File(
          [array.buffer.slice(array.byteOffset, array.byteLength + array.byteOffset)],
          event.data.fileInfo.attachment.name,
          { type: event.data.fileInfo.type },
        );
        const newAttachment: Attachment = { ...event.data.fileInfo.attachment, decryptedDocument: newDocument };
        this.subjects[event.data.subjectId].next(newAttachment);
        this.subjects[event.data.subjectId].complete();
        delete this.subjects[event.data.subjectId];
      } else if (event.data.encryptSecureMessageReply) {
        this.store.dispatch(
          new UpdateSecureMessageEncryptedContent({
            inProgress: false,
            encryptedContent: event.data.encryptedContent,
          }),
        );
      } else if (event.data.encryptJson) {
        if (event.data.isAddContact) {
          this.store.dispatch(
            new ContactAdd({
              id: event.data.id,
              encrypted_data: event.data.encryptedContent,
              is_encrypted: true,
            }),
          );
        }
      } else if (event.data.decryptJson) {
        if (event.data.isContact) {
          this.store.dispatch(new ContactDecryptSuccess({ ...JSON.parse(event.data.content), id: event.data.id }));
        } else if (event.data.isContactsArray) {
          const totalDecryptedContacts = this.contactsState.noOfDecryptedContacts + event.data.contacts.length;
          this.store.dispatch(new UpdateBatchContacts({ contact_list: event.data.contacts }));
          if (this.contactsState.totalContacts > totalDecryptedContacts) {
            this.store.dispatch(
              new ContactsGet({
                limit: 20,
                offset: totalDecryptedContacts,
                isDecrypting: true,
              }),
            );
          }
        }
      } else if (event.data.getKeyInfoFromPublicKey) {
        // Handling error
        if (event.data.error) {
          if (this.subjects[event.data.subjectId]) {
            this.subjects[event.data.subjectId].error(event.data.errorMessage);
          }
        } else if (this.subjects[event.data.subjectId]) {
          this.subjects[event.data.subjectId].next(event.data.keyInfo);
          this.subjects[event.data.subjectId].complete();
          delete this.subjects[event.data.subjectId];
        }
      } else if (event.data.generateKeysForEmail) {
        // Handling error
        if (event.data.error) {
          if (this.subjects[event.data.subjectId]) {
            this.subjects[event.data.subjectId].error(event.data.errorMessage);
          }
        } else if (this.subjects[event.data.subjectId]) {
          this.subjects[event.data.subjectId].next(event.data.keys);
          this.subjects[event.data.subjectId].complete();
          delete this.subjects[event.data.subjectId];
        }
      } else if (event.data.encryptedForPGPMimeContent) {
        this.store.dispatch(
          new UpdatePGPMimeEncrytion({
            isPGPMimeInProgress: false,
            encryptedContent: event.data.data,
            draftId: event.data.draftId,
          }),
        );
      }
    };
  }
}
